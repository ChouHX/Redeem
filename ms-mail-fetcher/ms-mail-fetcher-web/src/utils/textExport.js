function downloadByBlob(content, fileName) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
}

function getPywebviewApi() {
    if (typeof window === 'undefined') return null
    return window.pywebview?.api || null
}

export async function exportTextFile(content, fileName) {
    const desktopApi = getPywebviewApi()
    if (desktopApi?.save_text_file) {
        const result = await desktopApi.save_text_file(content, fileName)
        if (result?.saved || result?.canceled) return { mode: 'desktop', ...result }
    }

    downloadByBlob(content, fileName)
    return { mode: 'browser', saved: true }
}
