interface Tab {
  id: string;
  label: string;
  count?: number;
  countVariant?: 'default' | 'warning' | 'danger';
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
  variant?: 'underline' | 'pill';
}

export function Tabs({ tabs, activeTab, onChange, variant = 'underline' }: TabsProps) {
  if (variant === 'pill') {
    return (
      <div className="flex gap-2 mb-4">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`
                px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                ${isActive
                  ? 'bg-btn-primary hover:bg-btn-primary-hover text-white'
                  : 'text-secondary hover:text-primary hover:bg-card-hover'
                }
              `}
            >
              <span className="flex items-center gap-1.5">
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span
                    className={`text-[11px] font-normal ${
                      isActive
                        ? 'text-white/70'
                        : tab.countVariant === 'danger'
                          ? 'text-status-danger-text/70'
                          : tab.countVariant === 'warning'
                            ? 'text-status-warning-text/70'
                            : 'text-muted'
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex gap-1 border-b border-edge mb-4">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`
              relative px-3 py-2 text-sm font-medium transition-colors
              ${isActive
                ? 'text-primary'
                : 'text-muted hover:text-secondary'
              }
            `}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span
                  className={`text-[11px] font-normal ${
                    tab.countVariant === 'danger'
                      ? 'text-status-danger-text/70'
                      : tab.countVariant === 'warning'
                        ? 'text-status-warning-text/70'
                        : 'text-muted'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </span>
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}
