import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';

interface PricingCardProps {
  name: string;
  badge?: string;
  amount: number;
  cadence: string;
  audience: string;
  features: string[];
  ctaLabel: string;
  ctaHref: string;
  featured?: boolean;
  current?: boolean;
  /** Disable the CTA (e.g. until the buyer has chosen which org to upgrade). */
  ctaDisabled?: boolean;
}

export function PricingCard({
  name,
  badge,
  amount,
  cadence,
  audience,
  features,
  ctaLabel,
  ctaHref,
  featured,
  current,
  ctaDisabled,
}: PricingCardProps) {
  const navigate = useNavigate();

  return (
    <div
      className={`relative flex flex-col rounded-xl p-6 border transition-colors ${
        current
          ? 'border-accent bg-accent/5'
          : featured
            ? 'border-edge-strong bg-panel'
            : 'border-edge bg-panel'
      }`}
    >
      {current && (
        <span className="absolute -top-3 left-6 px-2.5 py-0.5 text-xs font-medium rounded-full bg-accent text-on-accent">
          Current plan
        </span>
      )}
      {badge && !current && (
        <span className="absolute -top-3 left-6 px-2.5 py-0.5 text-xs font-medium rounded-full bg-btn-primary text-white">
          {badge}
        </span>
      )}

      <div className="mb-4">
        <h3 className="text-lg font-semibold text-heading">{name}</h3>
        <p className="mt-1 text-sm text-muted">{audience}</p>
      </div>

      <div className="mb-6">
        {amount === 0 ? (
          <span className="text-3xl font-bold text-heading">Free</span>
        ) : (
          <>
            <span className="text-3xl font-bold text-heading">${amount}</span>
            <span className="ml-1 text-sm text-muted">{cadence}</span>
          </>
        )}
      </div>

      <ul className="mb-6 space-y-2 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-secondary">
            <span className="mt-0.5 text-status-success-text">✓</span>
            {f}
          </li>
        ))}
      </ul>

      {current ? (
        <button
          disabled
          className="w-full py-2 text-sm font-medium rounded-lg border border-edge text-muted cursor-default"
        >
          Current plan
        </button>
      ) : (
        <Button
          variant="primary"
          className="w-full justify-center"
          disabled={ctaDisabled}
          onClick={() => navigate(ctaHref)}
        >
          {ctaLabel}
        </Button>
      )}
    </div>
  );
}
