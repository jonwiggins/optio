"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, Eye, EyeOff, ExternalLink } from "lucide-react";
import type {
  AgentCredential,
  AgentCredentialMethodOption,
  ResourceOwner,
  VerifyAgentCredentialResult,
} from "@optio/shared";
import { api } from "@/lib/api-client";
import { ownerOf, scopeOf } from "@/lib/owner";
import { Dialog } from "@/components/ui/dialog";
import { inputClass } from "@/components/ui/input";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { Segmented } from "@/components/ui/segmented";

/** The pseudo-method that explains where Bedrock providers are made. */
const BEDROCK = "__bedrock__";

const FIELD_LABEL: Record<AgentCredentialMethodOption["input"], string> = {
  token: "Key or token",
  url: "URL",
  project: "Project id",
};

/**
 * `+` on the "Signed in with" row: store a sign-in secret for the agent — a
 * key, a token, an app-server URL — as the organization's or your own, and
 * pick it. The value is sent once and never shown again. Bedrock is a model
 * provider, made in Settings.
 */
export function AddCredentialDialog({
  agentType,
  agentLabel,
  addable,
  isAdmin,
  initialOwner,
  onClose,
  onAdded,
}: {
  agentType: string;
  agentLabel: string;
  addable: AgentCredentialMethodOption[];
  isAdmin: boolean;
  initialOwner: ResourceOwner;
  onClose: () => void;
  onAdded: (credential: AgentCredential) => void;
}) {
  const [method, setMethod] = useState<string>(addable[0]?.secretName ?? BEDROCK);
  const [value, setValue] = useState("");
  const [owner, setOwner] = useState<ResourceOwner>(isAdmin ? initialOwner : "me");
  const [show, setShow] = useState(false);
  const [checkFirst, setCheckFirst] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<VerifyAgentCredentialResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const option = addable.find((o) => o.secretName === method);
  const trimmed = value.trim();
  const bedrockOnly = addable.length === 0;

  const pick = (m: string) => {
    setMethod(m);
    setValue("");
    setChecked(null);
    setError(null);
  };

  const test = async () => {
    if (!option || !trimmed) return;
    setChecking(true);
    setError(null);
    try {
      setChecked(
        await api.verifyAgentCredential({
          agentType,
          secretName: option.secretName,
          value: trimmed,
        }),
      );
    } catch (err) {
      setChecked({ valid: false, error: err instanceof Error ? err.message : "Couldn't check it" });
    } finally {
      setChecking(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!option || !trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createAgentCredential({
        agentType,
        secretName: option.secretName,
        value: trimmed,
        owner,
        // A value the Test button accepted is not checked twice; an unticked
        // box skips the check (air-gapped deployments, a key not yet enabled).
        ...(option.verifiable ? { verify: checkFirst && !checked?.valid } : {}),
      });
      onAdded(res.credential);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save it");
      setSaving(false);
    }
  };

  const busy = saving || checking;
  const methodOptions = [
    ...addable.map((o) => ({
      value: o.secretName,
      label: o.label,
      testId: `credential-method-${o.secretName}`,
    })),
    { value: BEDROCK, label: "Amazon Bedrock…", testId: "credential-method-bedrock" },
  ];

  return (
    <Dialog
      title={`Add credentials for ${agentLabel}`}
      description="What the agent signs in with when this work runs in a pod. Stored encrypted; never shown again."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text disabled:opacity-50"
          >
            {option ? "Cancel" : "Close"}
          </button>
          {option?.verifiable && (
            <button
              type="button"
              data-testid="credential-verify"
              onClick={test}
              disabled={busy || !trimmed}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-hover disabled:opacity-50"
            >
              {checking ? "Checking…" : "Test"}
            </button>
          )}
          {option && (
            <button
              type="submit"
              form="add-credential-form"
              data-testid="credential-save"
              disabled={busy || !trimmed}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save and use it"}
            </button>
          )}
        </>
      }
    >
      <form
        id="add-credential-form"
        data-testid="credential-dialog"
        className="space-y-4"
        onSubmit={save}
      >
        <div>
          <span className="block text-xs text-text-muted mb-1">Method</span>
          <Segmented
            aria-label="Method"
            wrap
            value={method}
            onChange={pick}
            options={methodOptions}
          />
        </div>

        {option ? (
          <>
            <div>
              <label htmlFor="credential-value" className="block text-xs text-text-muted mb-1">
                {FIELD_LABEL[option.input]}
              </label>
              <div className="relative">
                <input
                  id="credential-value"
                  data-testid="credential-value"
                  type={
                    option.input === "url"
                      ? "url"
                      : option.input === "token" && !show
                        ? "password"
                        : "text"
                  }
                  inputMode={option.input === "url" ? "url" : "text"}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setChecked(null);
                  }}
                  placeholder={
                    option.input === "url"
                      ? "http://…"
                      : option.input === "project"
                        ? "my-gcp-project"
                        : "Paste it here"
                  }
                  className={inputClass({
                    className: option.input === "token" ? "pr-10 font-mono" : "",
                  })}
                />
                {option.input === "token" && (
                  <button
                    type="button"
                    aria-label={show ? "Hide the value" : "Show the value"}
                    onClick={() => setShow((s) => !s)}
                    className="absolute inset-y-0 right-2 flex items-center text-text-muted hover:text-text"
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                )}
              </div>
              {option.hint && (
                <p className="text-[11px] text-text-muted/80 mt-1.5">{option.hint}</p>
              )}
              {checked && (
                <p
                  data-testid="credential-verify-result"
                  className={`mt-1.5 text-xs ${checked.valid ? "text-success" : "text-danger"}`}
                >
                  {checked.valid ? (
                    <>
                      <Check className="mr-1 inline h-3 w-3" />
                      Works{checked.detail ? ` · ${checked.detail}` : ""}
                    </>
                  ) : (
                    (checked.error ?? "The service rejected it")
                  )}
                </p>
              )}
            </div>

            {option.verifiable && (
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  data-testid="credential-verify-toggle"
                  checked={checkFirst}
                  onChange={(e) => setCheckFirst(e.target.checked)}
                />
                Check it with the service before saving
              </label>
            )}

            <OwnerPicker
              label="Owner"
              what="credential"
              value={scopeOf(owner)}
              onChange={(v) => setOwner(ownerOf(v))}
              canOrg={isAdmin}
              orgHint="Everyone's work in the workspace can sign in with it."
              privateHint="Only your work can sign in with it; picking it makes this work yours."
            />
            {!isAdmin && (
              <p className="text-[11px] text-text-muted/80">
                Only admins add organization credentials.
              </p>
            )}

            {error && (
              <p data-testid="credential-error" className="text-xs text-danger">
                {error}
              </p>
            )}
          </>
        ) : (
          <div className="space-y-2 text-sm text-text-muted">
            <p>
              Amazon Bedrock is a <strong className="text-text">model provider</strong>: a region,
              the models it offers {agentLabel}, and the AWS credentials a pod signs in with. Once
              one is set up it appears here as a sign-in.
            </p>
            {bedrockOnly && (
              <p>{agentLabel} has no key or token to add here; its sign-in is a provider.</p>
            )}
            <Link
              href="/settings#model-providers"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              data-testid="credential-bedrock-link"
            >
              Set up a model provider in Settings
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}
      </form>
    </Dialog>
  );
}
