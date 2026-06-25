import '@testing-library/jest-dom/vitest';
// Install Memex AC emission hooks: the @memex-ai-ac/vitest package's setup module
// registers beforeEach/afterEach so any test calling tagAc('<canonical-ac-ref>')
// POSTs a pass/fail event to the namespace-derived Memex server. Untagged tests
// emit nothing.
import '@memex-ai-ac/vitest/setup';

// jsdom doesn't implement scrollIntoView — the highlight/navigate tools call it.
Element.prototype.scrollIntoView = () => {};
