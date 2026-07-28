import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { CATALOG, providersByCategory, contextWindow, type Category } from "../providers/catalog.ts";
import type { AgentConfig } from "../agent/agent.ts";
import { theme, compactNumber } from "./theme.ts";

// Minimal arrow-key list (↑/↓/Enter/Esc). ~20 lines beats a dependency for this.
function Select({
  items,
  onSelect,
  onCancel,
}: {
  items: { label: string; value: string }[];
  onSelect: (v: string) => void;
  onCancel: () => void;
}) {
  const [i, setI] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setI((p) => (p - 1 + items.length) % items.length);
    else if (key.downArrow) setI((p) => (p + 1) % items.length);
    else if (key.return) onSelect(items[i]!.value);
    else if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column">
      {items.map((it, idx) => (
        <Text key={it.value} color={idx === i ? theme.info : undefined}>
          {idx === i ? "❯ " : "  "}
          {it.label}
        </Text>
      ))}
    </Box>
  );
}

function Panel({ title, error, children }: { title: string; error?: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.info} marginTop={1} paddingX={1}>
      <Text bold color={theme.info}>
        {title}
      </Text>
      <Text dimColor>↑/↓ move · Enter select · Esc cancel</Text>
      {error ? <Text color={theme.error}>{error}</Text> : null}
      {children}
    </Box>
  );
}

const CUSTOM_MODEL = "__custom_model__";

// opencode-style picker: agent → supply method (API key / Local / Sign in) → provider → model.
// onPick returns an error string (missing key / not signed in) or undefined on success.
export function ModelSelector({
  agents,
  onPick,
  onCancel,
}: {
  agents: AgentConfig[];
  onPick: (agentId: string, provider: string, model: string, baseURL?: string) => string | undefined;
  onCancel: () => void;
}) {
  const [agentId, setAgentId] = useState<string | undefined>(agents.length === 1 ? agents[0]!.id : undefined);
  const [category, setCategory] = useState<Category | undefined>();
  const [provider, setProvider] = useState<string | undefined>();
  const [baseURL, setBaseURL] = useState<string>("");
  const [baseURLDone, setBaseURLDone] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [pickingCustomModel, setPickingCustomModel] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function finish(model: string) {
    if (!model) return;
    const err = onPick(agentId!, provider!, model, provider === "custom" ? baseURL : undefined);
    if (err) {
      setError(err); // e.g. "not signed in… Run: amux login copilot" — let them pick again
      setProvider(undefined);
      setBaseURLDone(false);
      setPickingCustomModel(false);
    } else {
      onCancel();
    }
  }

  // Step 1 — which agent (skipped when there's only one).
  if (!agentId) {
    return (
      <Panel title="Switch model — select agent" error={error}>
        <Select
          items={agents.map((a) => ({ label: `${a.id} · ${a.role}  (${a.provider}/${a.model})`, value: a.id }))}
          onSelect={setAgentId}
          onCancel={onCancel}
        />
      </Panel>
    );
  }

  // Step 2 — how to supply the model.
  if (!category) {
    return (
      <Panel title={`Switch model for ${agentId} — how do you want to connect?`} error={error}>
        <Select
          items={[
            { label: "API key — bring your own (Anthropic, OpenAI, Groq, DeepSeek, custom, …)", value: "byok" },
            { label: "Local — run offline (Ollama, LM Studio)", value: "local" },
            { label: "Sign in — use a subscription (GitHub Copilot)", value: "login" },
          ]}
          onSelect={(v) => {
            setError(undefined);
            setCategory(v as Category);
          }}
          onCancel={onCancel}
        />
      </Panel>
    );
  }

  // Step 3 — pick a provider within the chosen category.
  if (!provider) {
    const title = category === "local" ? "Local" : category === "login" ? "Sign in" : "API key";
    return (
      <Panel title={`${title} — select provider`} error={error}>
        <Select
          items={providersByCategory(category).map((k) => ({ label: CATALOG[k]!.label, value: k }))}
          onSelect={(p) => {
            setError(undefined);
            setProvider(p);
          }}
          onCancel={onCancel}
        />
      </Panel>
    );
  }

  // Custom provider: prompt for the endpoint base URL first.
  if (provider === "custom" && !baseURLDone) {
    return (
      <Panel title="Custom endpoint — base URL">
        <Box>
          <Text color={theme.success}>▸ </Text>
          <TextInput
            value={baseURL}
            onChange={setBaseURL}
            onSubmit={(u) => u.trim() && setBaseURLDone(true)}
            placeholder="https://host/v1"
          />
        </Box>
      </Panel>
    );
  }

  // Step 4 — pick a model. Providers with no seed models (custom) go straight to typing an id.
  if (pickingCustomModel || CATALOG[provider]!.models.length === 0) {
    return (
      <Panel title={`Model id for ${CATALOG[provider]!.label}`}>
        <Box>
          <Text color={theme.success}>▸ </Text>
          <TextInput value={customModel} onChange={setCustomModel} onSubmit={(m) => finish(m.trim())} placeholder="model id…" />
        </Box>
      </Panel>
    );
  }
  const ctx = compactNumber(contextWindow(provider));
  return (
    <Panel title={`Select model (${CATALOG[provider]!.label})`} error={error}>
      <Select
        items={[
          ...CATALOG[provider]!.models.map((m) => ({ label: `${m} (${ctx} ctx)`, value: m })),
          { label: "custom…", value: CUSTOM_MODEL },
        ]}
        onSelect={(m) => (m === CUSTOM_MODEL ? setPickingCustomModel(true) : finish(m))}
        onCancel={onCancel}
      />
    </Panel>
  );
}
