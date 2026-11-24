import React from 'react';
import { Image as ImageIcon, KeyRound, Plus, Trash2 } from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import { formatMoney } from '../core/rebalancer';

interface ProjectSidebarProps {
  open: boolean;
  onOpenSettings: () => void;
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export const ProjectSidebar: React.FC<ProjectSidebarProps> = ({ open, onOpenSettings }) => {
  const projects = usePricerStore((s) => s.projects);
  const activeProjectId = usePricerStore((s) => s.activeProject?.id);
  const selectProject = usePricerStore((s) => s.selectProject);
  const createBlankProject = usePricerStore((s) => s.createBlankProject);
  const deleteProject = usePricerStore((s) => s.deleteProject);
  const aiConfig = usePricerStore((s) => s.settings.aiConfig);

  const engineLabel =
    aiConfig.protocol === 'server_default'
      ? '默认 Gemini'
      : `自定义 · ${aiConfig.model.trim() || aiConfig.protocol}`;

  if (!open) return null;

  return (
    <aside
      aria-label="拼团工程列表"
      className="w-[248px] shrink-0 bg-white border-r border-[#E4E7EC] flex flex-col h-full select-none"
    >
      <div className="px-4 py-3.5 border-b border-[#EEF0F4] flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-slate-900 tracking-wide">拼团存档</h2>
        <button
          type="button"
          onClick={() => void createBlankProject()}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建拼团</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {projects.map((proj) => {
          const isActive = proj.id === activeProjectId;
          return (
            <div
              key={proj.id}
              className={`group relative rounded-lg transition-colors ${
                isActive ? 'bg-slate-100' : 'hover:bg-slate-50'
              }`}
            >
              <button
                type="button"
                onClick={() => void selectProject(proj.id)}
                className="w-full text-left p-2 flex items-start gap-2.5 pr-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 rounded-lg"
              >
                <div className="w-12 h-10 rounded-md overflow-hidden bg-slate-100 border border-slate-200/80 shrink-0 flex items-center justify-center">
                  {proj.thumbDataUrl ? (
                    <img
                      src={proj.thumbDataUrl}
                      alt={proj.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="w-4 h-4 text-slate-400" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div
                    className={`text-xs font-semibold truncate ${
                      isActive ? 'text-slate-950' : 'text-slate-800'
                    }`}
                  >
                    {proj.name}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500 flex items-center gap-1 truncate tabular-nums">
                    <span className="truncate">{proj.ipName || '未填作品'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">{proj.itemCount}件</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono shrink-0 text-slate-700">
                      ¥{formatMoney(proj.targetTotal)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    {formatRelativeTime(proj.updatedAt)}
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteProject(proj.id);
                }}
                aria-label={`删除「${proj.name}」`}
                title="删除拼团"
                className="absolute right-1.5 top-2 p-1.5 rounded-md text-slate-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-rose-600 hover:bg-rose-50 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-[#EEF0F4] space-y-1.5">
        <button
          type="button"
          onClick={onOpenSettings}
          className="w-full text-left px-2.5 py-2 rounded-lg text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
        >
          <span className="inline-flex items-center gap-2">
            <KeyRound className="w-3.5 h-3.5 text-slate-500" />
            <span>AI 密钥与服务设置</span>
          </span>
          <div className="mt-0.5 pl-5.5 text-[11px] font-normal text-slate-400 truncate">
            当前引擎：{engineLabel}
          </div>
        </button>
        <p className="px-2.5 text-[11px] leading-relaxed text-slate-400">
          支持 Ctrl+V 直接粘贴截图、拖拽防挡脸、Ctrl+Z 撤回。
        </p>
      </div>
    </aside>
  );
};
