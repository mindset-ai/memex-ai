import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, fetchWithRetry } from '../api/http';

interface FormState {
  fullName: string;
  email: string;
  company: string;
  seats: string;
  deploymentContext: string;
}

interface FieldErrors {
  fullName?: string;
  email?: string;
  company?: string;
  seats?: string;
}

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.fullName.trim()) errors.fullName = 'Full name is required.';
  if (!form.email.trim()) {
    errors.email = 'Email is required.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    errors.email = 'Please enter a valid email address.';
  }
  if (!form.company.trim()) errors.company = 'Company name is required.';
  if (!form.seats.trim() || isNaN(parseInt(form.seats, 10)) || parseInt(form.seats, 10) < 1) {
    errors.seats = 'Estimated seat count is required.';
  }
  return errors;
}

export function SelfHostedContact() {
  const navigate = useNavigate();

  const [form, setForm] = useState<FormState>({
    fullName: '',
    email: '',
    company: '',
    seats: '',
    deploymentContext: '',
  });
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const errors = validate(form);
  const visibleErrors = Object.fromEntries(
    Object.entries(errors).filter(([k]) => touched[k as keyof FormState])
  ) as FieldErrors;

  function handleBlur(field: keyof FormState) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  function handleChange(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Mark all fields touched to show any remaining errors
    setTouched({ fullName: true, email: true, company: true, seats: true });
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const [firstName, ...rest] = form.fullName.trim().split(' ');
      const res = await fetchWithRetry(`${BASE_URL}/enterprise/self-hosted/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstname: firstName,
          lastname: rest.join(' ') || '',
          email: form.email.trim(),
          company: form.company.trim(),
          estimatedSeats: parseInt(form.seats, 10),
          deploymentContext: form.deploymentContext.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setSubmitted(true);
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-6 py-16 text-center">
        <div className="mb-6 inline-flex items-center justify-center w-14 h-14 rounded-full bg-status-success-bg">
          <span className="text-2xl text-status-success-text">✓</span>
        </div>
        <h1 className="text-2xl font-bold text-heading mb-2">Thanks!</h1>
        <p className="text-sm text-muted mb-6">We'll be in touch within 24 hours.</p>
        <button
          className="text-sm text-btn-primary hover:underline"
          onClick={() => navigate('/')}
        >
          Back to Memex
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold text-heading mb-1">
        Talk to our team about Self-Hosted Enterprise
      </h1>
      <p className="text-sm text-muted mb-8">
        Get pricing, discuss deployment needs, or request a commercial license.
      </p>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {/* Full name */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1" htmlFor="full-name">
            Full name <span aria-hidden="true">*</span>
          </label>
          <input
            id="full-name"
            type="text"
            required
            autoComplete="name"
            value={form.fullName}
            onChange={(e) => handleChange('fullName', e.target.value)}
            onBlur={() => handleBlur('fullName')}
            aria-describedby={visibleErrors.fullName ? 'full-name-error' : undefined}
            aria-invalid={!!visibleErrors.fullName}
            className={`w-full rounded-lg border px-3 py-2 text-sm text-primary bg-input focus:outline-none focus:ring-2 focus:ring-accent ${visibleErrors.fullName ? 'border-status-danger-border' : 'border-edge'}`}
          />
          {visibleErrors.fullName && (
            <p id="full-name-error" role="alert" className="mt-1 text-xs text-status-danger-text">
              {visibleErrors.fullName}
            </p>
          )}
        </div>

        {/* Email */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1" htmlFor="email">
            Email <span aria-hidden="true">*</span>
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => handleChange('email', e.target.value)}
            onBlur={() => handleBlur('email')}
            aria-describedby={visibleErrors.email ? 'email-error' : undefined}
            aria-invalid={!!visibleErrors.email}
            className={`w-full rounded-lg border px-3 py-2 text-sm text-primary bg-input focus:outline-none focus:ring-2 focus:ring-accent ${visibleErrors.email ? 'border-status-danger-border' : 'border-edge'}`}
          />
          {visibleErrors.email && (
            <p id="email-error" role="alert" className="mt-1 text-xs text-status-danger-text">
              {visibleErrors.email}
            </p>
          )}
        </div>

        {/* Company */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1" htmlFor="company">
            Company name <span aria-hidden="true">*</span>
          </label>
          <input
            id="company"
            type="text"
            required
            autoComplete="organization"
            value={form.company}
            onChange={(e) => handleChange('company', e.target.value)}
            onBlur={() => handleBlur('company')}
            aria-describedby={visibleErrors.company ? 'company-error' : undefined}
            aria-invalid={!!visibleErrors.company}
            className={`w-full rounded-lg border px-3 py-2 text-sm text-primary bg-input focus:outline-none focus:ring-2 focus:ring-accent ${visibleErrors.company ? 'border-status-danger-border' : 'border-edge'}`}
          />
          {visibleErrors.company && (
            <p id="company-error" role="alert" className="mt-1 text-xs text-status-danger-text">
              {visibleErrors.company}
            </p>
          )}
        </div>

        {/* Seat count */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1" htmlFor="seats">
            Estimated seat count <span aria-hidden="true">*</span>
          </label>
          <input
            id="seats"
            type="number"
            required
            min={1}
            value={form.seats}
            onChange={(e) => handleChange('seats', e.target.value)}
            onBlur={() => handleBlur('seats')}
            aria-describedby={visibleErrors.seats ? 'seats-error' : undefined}
            aria-invalid={!!visibleErrors.seats}
            className={`w-full rounded-lg border px-3 py-2 text-sm text-primary bg-input focus:outline-none focus:ring-2 focus:ring-accent ${visibleErrors.seats ? 'border-status-danger-border' : 'border-edge'}`}
          />
          {visibleErrors.seats && (
            <p id="seats-error" role="alert" className="mt-1 text-xs text-status-danger-text">
              {visibleErrors.seats}
            </p>
          )}
        </div>

        {/* Deployment context */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1" htmlFor="deployment-context">
            Deployment context <span className="text-muted font-normal">(optional)</span>
          </label>
          <textarea
            id="deployment-context"
            rows={3}
            value={form.deploymentContext}
            onChange={(e) => handleChange('deploymentContext', e.target.value)}
            placeholder="Tell us about your deployment needs (on-prem, cloud provider, compliance requirements, etc.)"
            className="w-full rounded-lg border border-edge px-3 py-2 text-sm text-primary bg-input focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>

        {submitError && (
          <p role="alert" className="text-sm text-status-danger-text bg-status-danger-bg rounded-lg px-3 py-2">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 text-sm font-medium rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : 'Submit'}
        </button>
      </form>
    </div>
  );
}
