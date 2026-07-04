import { Button } from "@/components/ui/button";
import { Gem } from "lucide-react";
import { cn } from "@/lib/utils";

type AdSlotAction = {
  label: string;
  href: string;
};

interface AdSlotCardProps {
  title: string;
  description: string;
  imageUrl?: string;
  primaryAction?: AdSlotAction;
  compact?: boolean;
  className?: string;
}

export function AdSlotCard({
  title,
  description,
  imageUrl,
  primaryAction,
  compact = false,
  className,
}: AdSlotCardProps) {
  return (
    <div
      className={cn(
        "ad-slot-promo group relative overflow-hidden rounded-2xl border border-zinc-200/50 bg-white/95 p-3 shadow-sm transition-shadow duration-300 hover:shadow-md dark:border-zinc-800/50 dark:bg-zinc-900/90",
        compact && "p-3",
        className
      )}
    >
      {/* Background glow — static, no animation, GPU-promoted */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-blue-500/8 blur-2xl" />
        <div className="absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-indigo-500/8 blur-2xl" />
      </div>

      {/* Scan effect — only on hover, GPU-composited */}
      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden opacity-0 transition-opacity duration-500 group-hover:opacity-100">
        <div className="ad-slot-scan h-full w-24 bg-gradient-to-r from-transparent via-white/30 to-transparent will-change-transform dark:via-white/5" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex items-center gap-3.5">
        {imageUrl && (
          <div className="relative shrink-0">
            <div className="relative z-10 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-sm size-14 transition-transform duration-500 group-hover:scale-105 dark:border-zinc-700/50 dark:bg-zinc-800">
              <img
                src={imageUrl}
                alt={title}
                className="size-full object-cover"
                loading="lazy"
              />
            </div>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold leading-none tracking-tight text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          <div className="mt-1.5 overflow-hidden">
            <div className="ad-slot-marquee flex w-max min-w-full items-center gap-8 sm:block sm:w-auto">
              <p className="shrink-0 whitespace-nowrap text-xs font-medium leading-[1.4] text-zinc-500 dark:text-zinc-400 sm:line-clamp-2 sm:whitespace-normal">
                {description}
              </p>
              <p
                className="shrink-0 whitespace-nowrap text-xs font-medium leading-[1.4] text-zinc-500 dark:text-zinc-400 sm:hidden"
                aria-hidden="true"
              >
                {description}
              </p>
            </div>
          </div>
        </div>

        {primaryAction && (
          <div className="shrink-0 pl-1">
            <div className="ad-slot-border-wrap relative inline-flex rounded-full overflow-hidden p-[1px]">
              <span className="absolute inset-0 rounded-full pointer-events-none overflow-hidden">
                <span className="ad-slot-spin absolute -inset-full bg-[conic-gradient(from_0deg,_#3b82f6_0deg,_#3b82f6_40deg,_transparent_60deg)] will-change-transform" />
              </span>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="relative z-10 h-8 rounded-full bg-white px-4 text-xs font-bold border-none shadow-none dark:bg-zinc-900 dark:text-zinc-100 hover:bg-white dark:hover:bg-zinc-900 active:scale-95"
              >
                <a target="_blank" href={primaryAction.href} className="flex items-center gap-1.5">
                  <Gem className="size-3.5 text-blue-500 dark:text-blue-400" />
                  {primaryAction.label}
                </a>
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-zinc-500/10 to-transparent dark:via-zinc-400/20" />
    </div>
  );
}
