import { PageHeader } from '../components/PageHeader';

export function Decisions() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <PageHeader title="Decisions" />
        <p className="mt-2 text-secondary">Open questions and resolved decisions across all your specs</p>
        <div className="mt-12 rounded-lg border border-edge bg-card-hover/40 p-12 text-center">
          <p className="text-sm text-muted">Coming soon</p>
        </div>
      </div>
    </div>
  );
}
