import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const DOCKER_COMMAND = 'docker pull memex/self-hosted:latest';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-2 px-2 py-0.5 text-xs rounded border border-edge text-muted hover:text-secondary hover:border-edge-strong transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export function SelfHostedDownload() {
  const navigate = useNavigate();

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold text-heading mb-2">
        Download Memex Self-Hosted Enterprise
      </h1>
      <p className="text-sm text-muted mb-10">
        Run Memex on your own infrastructure with your own LLM keys.
      </p>

      <div className="space-y-8">
        {/* Step 1: Docker */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <h2 className="text-sm font-semibold text-heading mb-1">
            1. Pull the Docker image
          </h2>
          <p className="text-xs text-muted mb-3">
            Runs on any Docker-compatible infrastructure (Linux, macOS, Windows with WSL2)
          </p>
          <div className="flex items-center gap-2 rounded-md bg-surface/50 border border-edge px-3 py-2">
            <code className="flex-1 text-xs text-primary font-mono">{DOCKER_COMMAND}</code>
            <CopyButton text={DOCKER_COMMAND} />
          </div>
        </section>

        {/* Step 2: Install docs */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <h2 className="text-sm font-semibold text-heading mb-1">
            2. Follow the installation guide
          </h2>
          <p className="text-xs text-muted mb-3">
            Step-by-step setup guide (5–10 minutes)
          </p>
          <a
            href="/docs/self-hosted/installation"
            className="inline-flex items-center gap-1 text-sm text-btn-primary hover:underline"
          >
            View installation docs →
          </a>
        </section>

        {/* Step 3: Commercial license */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <h2 className="text-sm font-semibold text-heading mb-1">
            3. Get a commercial license
          </h2>
          <p className="text-xs text-muted mb-3">
            Talk to our team about pricing, seat counts, and deployment requirements.
          </p>
          <button
            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-white text-sm font-medium transition-colors"
            onClick={() => navigate('/enterprise/self-hosted/contact')}
          >
            Contact sales for a commercial license →
          </button>
        </section>
      </div>
    </div>
  );
}
