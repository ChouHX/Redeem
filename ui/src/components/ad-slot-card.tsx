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
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes float-subtle {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(4px, -4px) scale(1.02); }
        }
        @keyframes premium-scan {
          0% { transform: translateX(-150%) skewX(-25deg); }
          100% { transform: translateX(300%) skewX(-25deg); }
        }
        @keyframes pulse-soft {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.05); }
        }
        @keyframes spin-border {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}} />

      <div
        className={cn(
          "group relative overflow-hidden rounded-2xl border border-zinc-200/50 bg-white/80 p-3 shadow-sm transition-all duration-300 hover:shadow-md dark:border-zinc-800/50 dark:bg-zinc-900/60 backdrop-blur-xl",
          compact && "p-3",
          className
        )}
      >
        {/* 1. 背景流体层 */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div 
            className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-blue-500/10 blur-[40px]"
            style={{ animation: 'pulse-soft 8s ease-in-out infinite' }}
          />
          <div 
            className="absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-indigo-500/10 blur-[45px]"
            style={{ animation: 'pulse-soft 10s ease-in-out infinite reverse' }}
          />
        </div>

        {/* 2. 悬浮扫光特效 */}
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden opacity-0 transition-opacity duration-500 group-hover:opacity-100">
          <div 
            className="h-full w-24 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/5"
            style={{ animation: 'premium-scan 2s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}
          />
        </div>

        {/* 3. 内容层 */}
        <div className="relative z-10 flex items-center gap-3.5">
          {/* 图片区域 */}
          {imageUrl && (
            <div className="relative shrink-0">
              <div
                className="relative z-10 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-sm size-14 dark:border-zinc-700/50 dark:bg-zinc-800"
                style={{ animation: 'float-subtle 6s ease-in-out infinite' }}
              >
                <img
                  src={imageUrl}
                  alt={title}
                  className="size-full object-cover transition-transform duration-500 group-hover:scale-110"
                />
              </div>
              <div className="absolute inset-0 z-0 translate-y-1 bg-black/5 blur-md dark:bg-white/5" />
            </div>
          )}

          {/* 文本区域 */}
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-bold leading-none tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </h3>
            <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-[1.4] text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          </div>

          {/* 操作按钮：替换为 Animated Border 风格 */}
          {primaryAction && (
            <div className="shrink-0 pl-1">
              <div className="w-fit h-fit relative inline-flex rounded-full overflow-hidden p-[1px]">
                {/* 旋转边框层 */}
                <span className="absolute inset-0 rounded-full pointer-events-none overflow-hidden">
                  <span 
                    className="absolute -inset-full bg-[conic-gradient(from_0deg,_#3b82f6_0deg,_#3b82f6_40deg,_transparent_60deg)]"
                    style={{ animation: 'spin-border 4s linear infinite' }}
                  />
                </span>

                {/* 核心按钮 */}  
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className={cn(
                    "relative z-10 h-8 rounded-full bg-white px-4 text-xs font-bold transition-all shadow-none border-none",
                    "dark:bg-zinc-900 dark:text-zinc-100 hover:bg-white dark:hover:bg-zinc-900 active:scale-95"
                  )}
                >
                  <a target="_blank" href={primaryAction.href} className="flex items-center gap-1.5">
                    {/* 增加一个 Gem 图标提升 Pro 质感 */}
                    <Gem className="size-3.5 text-blue-500 dark:text-blue-400" />
                    {primaryAction.label}
                  </a>
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* 底部微光边框线 */}
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-zinc-500/10 to-transparent dark:via-zinc-400/20" />
      </div>
    </>
  );
}
