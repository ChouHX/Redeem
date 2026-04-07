import email
import imaplib
import os
import socket
from email import utils as email_utils
from email.header import decode_header

import requests


IMAP_SERVER = "outlook.live.com"
IMAP_PORT = 993
TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
INBOX_FOLDER_NAME = "INBOX"
JUNK_FOLDER_NAME = "Junk"

TOKEN_HTTP_TIMEOUT = float(os.getenv("MS_MAIL_TOKEN_TIMEOUT", "15"))
IMAP_TIMEOUT = float(os.getenv("MS_MAIL_IMAP_TIMEOUT", "20"))


def _token_request_kwargs() -> dict:
    return {"timeout": TOKEN_HTTP_TIMEOUT}


def _looks_like_html(content: str) -> bool:
    if not content:
        return False
    text = content.lstrip().lower()
    return (
        text.startswith("<!doctype html")
        or text.startswith("<html")
        or ("<body" in text and "</body>" in text)
    )


def decode_header_value(header_value) -> str:
    if header_value is None:
        return ""

    decoded_string = ""
    try:
        parts = decode_header(str(header_value))
        for part, charset in parts:
            if isinstance(part, bytes):
                try:
                    decoded_string += part.decode(charset or "utf-8", "replace")
                except LookupError:
                    decoded_string += part.decode("utf-8", "replace")
            else:
                decoded_string += str(part)
    except Exception:
        return str(header_value)
    return decoded_string


def _request_access_token(client_id: str, refresh_token: str) -> dict:
    response = requests.post(
        TOKEN_URL,
        data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
        },
        **_token_request_kwargs(),
    )
    response.raise_for_status()
    return response.json()


def _get_temp_access_token(client_id, refresh_token):
    try:
        token_data = _request_access_token(client_id, refresh_token)
        return token_data.get("access_token")
    except Exception as exc:
        print(f"Failed to get temporary access token: {exc}")
        return None


def refresh_oauth_token_manually(client_id, current_refresh_token):
    result = {
        "success": False,
        "new_refresh_token": "",
        "new_access_token": "",
        "error_msg": "",
    }
    try:
        token_data = _request_access_token(client_id, current_refresh_token)
        result["new_access_token"] = token_data.get("access_token", "")
        result["new_refresh_token"] = token_data.get("refresh_token", "")

        if result["new_access_token"] and result["new_refresh_token"]:
            result["success"] = True
        else:
            result["error_msg"] = "Microsoft token response is incomplete."
    except Exception as exc:
        result["error_msg"] = f"Refresh token failed: {exc}"

    return result


def _open_imap_connection(email_address: str, access_token: str):
    socket.setdefaulttimeout(IMAP_TIMEOUT)
    imap_conn = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    auth_string = f"user={email_address}\x01auth=Bearer {access_token}\x01\x01"
    typ, _ = imap_conn.authenticate("XOAUTH2", lambda _: auth_string.encode("utf-8"))
    if typ != "OK":
        raise RuntimeError("IMAP authentication failed.")
    return imap_conn


def _parse_header_fetch(msg_data, target_folder: str, uid_str: str) -> dict:
    subject_str = "(No Subject)"
    formatted_date_str = "(No Date)"
    from_name = "(Unknown)"
    from_email = ""

    if not msg_data or msg_data[0] is None:
        return {
            "uid": uid_str,
            "subject": subject_str,
            "from_name": from_name,
            "from_email": from_email,
            "date": formatted_date_str,
            "folder": target_folder,
        }

    header_content_bytes = None
    if isinstance(msg_data[0], tuple) and len(msg_data[0]) == 2:
        header_content_bytes = msg_data[0][1]
    elif isinstance(msg_data, list) and len(msg_data) > 1:
        header_content_bytes = msg_data[1]

    if header_content_bytes:
        header_message = email.message_from_bytes(header_content_bytes)
        subject_str = decode_header_value(header_message.get("Subject", "(No Subject)"))
        from_str = decode_header_value(header_message.get("From", "(Unknown Sender)"))

        if "<" in from_str and ">" in from_str:
            from_name = from_str.split("<")[0].strip().strip('"')
            from_email = from_str.split("<")[1].split(">")[0].strip()
        else:
            from_email = from_str.strip()
            if "@" in from_email:
                from_name = from_email.split("@")[0]

        date_header_str = header_message.get("Date")
        if date_header_str:
            try:
                dt_obj = email_utils.parsedate_to_datetime(date_header_str)
                if dt_obj:
                    formatted_date_str = dt_obj.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

    return {
        "uid": uid_str,
        "subject": subject_str,
        "from_name": from_name,
        "from_email": from_email,
        "date": formatted_date_str,
        "folder": target_folder,
    }


def get_emails_by_folder_paginated(
    email_address,
    refresh_token,
    client_id,
    target_folder=INBOX_FOLDER_NAME,
    page_number=0,
    emails_per_page=10,
):
    result = {
        "success": False,
        "error_msg": "",
        "total_emails": 0,
        "emails": [],
    }

    access_token = _get_temp_access_token(client_id, refresh_token)
    if not access_token:
        result["error_msg"] = "Unable to get a valid access token."
        return result

    imap_conn = None
    try:
        imap_conn = _open_imap_connection(email_address, access_token)

        typ, _ = imap_conn.select(target_folder, readonly=True)
        if typ != "OK":
            result["error_msg"] = f"Failed to select folder '{target_folder}'."
            return result

        typ, uid_data = imap_conn.uid("search", None, "ALL")
        if typ != "OK" or not uid_data or not uid_data[0]:
            result["success"] = True
            return result

        uids = uid_data[0].split()
        result["total_emails"] = len(uids)
        uids.reverse()

        start_index = page_number * emails_per_page
        end_index = start_index + emails_per_page
        page_uids = uids[start_index:end_index]

        emails_list = []
        for uid_bytes in page_uids:
            uid_str = uid_bytes.decode("utf-8", "replace")
            typ, msg_data = imap_conn.uid(
                "fetch",
                uid_bytes,
                "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE FROM)])",
            )
            if typ != "OK":
                emails_list.append(
                    {
                        "uid": uid_str,
                        "subject": "(Fetch Failed)",
                        "from_name": "(Unknown)",
                        "from_email": "",
                        "date": "(No Date)",
                        "folder": target_folder,
                    }
                )
                continue

            emails_list.append(_parse_header_fetch(msg_data, target_folder, uid_str))

        result["emails"] = emails_list
        result["success"] = True
        return result
    except Exception as exc:
        result["error_msg"] = f"Fetch mail list failed: {exc}"
        return result
    finally:
        if imap_conn:
            try:
                imap_conn.close()
                imap_conn.logout()
            except Exception:
                pass


def get_email_detail_by_uid(
    email_address,
    refresh_token,
    client_id,
    target_uid,
    target_folder=INBOX_FOLDER_NAME,
):
    result = {
        "success": False,
        "error_msg": "",
        "detail": {
            "subject": "",
            "from": "",
            "to": "",
            "date": "",
            "body_text": "",
            "body_html": "",
        },
    }

    access_token = _get_temp_access_token(client_id, refresh_token)
    if not access_token:
        result["error_msg"] = "Unable to get a valid access token."
        return result

    imap_conn = None
    try:
        imap_conn = _open_imap_connection(email_address, access_token)

        typ, _ = imap_conn.select(target_folder, readonly=True)
        if typ != "OK":
            result["error_msg"] = f"Failed to select folder '{target_folder}'."
            return result

        uid_bytes = target_uid.encode("utf-8") if isinstance(target_uid, str) else target_uid
        typ, msg_data = imap_conn.uid("fetch", uid_bytes, "(RFC822)")
        if typ != "OK" or not msg_data or msg_data[0] is None:
            result["error_msg"] = f"Mail with UID {target_uid} not found in {target_folder}."
            return result

        raw_email_bytes = None
        if isinstance(msg_data[0], tuple) and len(msg_data[0]) == 2:
            raw_email_bytes = msg_data[0][1]
        elif isinstance(msg_data, list):
            for item in msg_data:
                if isinstance(item, tuple) and len(item) == 2:
                    raw_email_bytes = item[1]
                    break

        if not raw_email_bytes:
            result["error_msg"] = "Unable to parse raw email payload."
            return result

        email_message = email.message_from_bytes(raw_email_bytes)

        result["detail"]["subject"] = decode_header_value(email_message.get("Subject", "(No Subject)"))
        result["detail"]["from"] = decode_header_value(email_message.get("From", "(Unknown Sender)"))
        result["detail"]["to"] = decode_header_value(email_message.get("To", "(Unknown Recipient)"))
        result["detail"]["date"] = email_message.get("Date", "(Unknown Date)")

        body_text = ""
        body_html = ""

        if email_message.is_multipart():
            for part in email_message.walk():
                content_type = part.get_content_type()
                content_disposition = str(part.get("Content-Disposition"))
                if "attachment" in content_disposition:
                    continue

                try:
                    charset = part.get_content_charset() or "utf-8"
                    payload = part.get_payload(decode=True)
                    if not payload:
                        continue
                    decoded_str = payload.decode(charset, errors="replace")
                    if content_type == "text/plain":
                        body_text += decoded_str
                    elif content_type == "text/html":
                        body_html += decoded_str
                except Exception:
                    pass
        else:
            try:
                charset = email_message.get_content_charset() or "utf-8"
                payload = email_message.get_payload(decode=True)
                if payload:
                    decoded_str = payload.decode(charset, errors="replace")
                    if email_message.get_content_type() == "text/html":
                        body_html = decoded_str
                    else:
                        body_text = decoded_str
            except Exception:
                pass

        body_text = body_text.strip()
        body_html = body_html.strip()

        if not body_html and _looks_like_html(body_text):
            body_html = body_text
            body_text = ""

        result["detail"]["body_text"] = body_text
        result["detail"]["body_html"] = body_html
        result["success"] = True
        return result
    except Exception as exc:
        result["error_msg"] = f"Fetch mail detail failed: {exc}"
        return result
    finally:
        if imap_conn:
            try:
                imap_conn.close()
                imap_conn.logout()
            except Exception:
                pass

