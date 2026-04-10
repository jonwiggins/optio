"use client";

import { useState, useEffect } from "react";

interface ParamsSchema {
  type?: string;
  properties?: Record<
    string,
    {
      type?: string;
      description?: string;
      enum?: string[];
      default?: unknown;
    }
  >;
  required?: string[];
}

interface WorkflowParamsFormProps {
  paramsSchema: ParamsSchema | Record<string, unknown> | null | undefined;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}

function isSchemaWithProperties(
  schema: ParamsSchema | Record<string, unknown> | null | undefined,
): schema is ParamsSchema & { properties: NonNullable<ParamsSchema["properties"]> } {
  if (!schema) return false;
  const s = schema as ParamsSchema;
  return !!s.properties && Object.keys(s.properties).length > 0;
}

export function WorkflowParamsForm({ paramsSchema, value, onChange }: WorkflowParamsFormProps) {
  if (!isSchemaWithProperties(paramsSchema)) {
    return <FreeformJsonEditor value={value} onChange={onChange} />;
  }

  const schema = paramsSchema as ParamsSchema & {
    properties: NonNullable<ParamsSchema["properties"]>;
  };
  const requiredFields = new Set(schema.required ?? []);

  const handleFieldChange = (field: string, fieldValue: unknown) => {
    onChange({ ...value, [field]: fieldValue });
  };

  return (
    <div className="space-y-4">
      {Object.entries(schema.properties).map(([field, fieldSchema]) => {
        const isRequired = requiredFields.has(field);
        const fieldType = fieldSchema.type ?? "string";
        const hasEnum = Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0;

        // Determine displayed value, falling back to schema default
        const currentValue = value[field] ?? fieldSchema.default;

        if (hasEnum) {
          return (
            <div key={field}>
              <label htmlFor={`param-${field}`} className="block text-xs font-medium mb-1">
                {field}
                {isRequired && <span className="text-error ml-0.5">*</span>}
              </label>
              {fieldSchema.description && (
                <p className="text-[10px] text-text-muted mb-1">{fieldSchema.description}</p>
              )}
              <select
                id={`param-${field}`}
                value={String(currentValue ?? "")}
                onChange={(e) => handleFieldChange(field, e.target.value || undefined)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="">Select...</option>
                {fieldSchema.enum!.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (fieldType === "boolean") {
          return (
            <div key={field}>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  id={`param-${field}`}
                  type="checkbox"
                  checked={Boolean(currentValue)}
                  onChange={(e) => handleFieldChange(field, e.target.checked)}
                  className="rounded"
                  aria-label={field}
                />
                {field}
                {isRequired && <span className="text-error ml-0.5">*</span>}
              </label>
              {fieldSchema.description && (
                <p className="text-[10px] text-text-muted mt-0.5 ml-6">{fieldSchema.description}</p>
              )}
            </div>
          );
        }

        if (fieldType === "number" || fieldType === "integer") {
          return (
            <div key={field}>
              <label htmlFor={`param-${field}`} className="block text-xs font-medium mb-1">
                {field}
                {isRequired && <span className="text-error ml-0.5">*</span>}
              </label>
              {fieldSchema.description && (
                <p className="text-[10px] text-text-muted mb-1">{fieldSchema.description}</p>
              )}
              <input
                id={`param-${field}`}
                type="number"
                value={currentValue != null ? String(currentValue) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    handleFieldChange(field, undefined);
                  } else {
                    handleFieldChange(field, Number(v));
                  }
                }}
                step={fieldType === "integer" ? 1 : "any"}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          );
        }

        // Default: string
        return (
          <div key={field}>
            <label htmlFor={`param-${field}`} className="block text-xs font-medium mb-1">
              {field}
              {isRequired && <span className="text-error ml-0.5">*</span>}
            </label>
            {fieldSchema.description && (
              <p className="text-[10px] text-text-muted mb-1">{fieldSchema.description}</p>
            )}
            <input
              id={`param-${field}`}
              type="text"
              value={String(currentValue ?? "")}
              onChange={(e) => handleFieldChange(field, e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>
        );
      })}
    </div>
  );
}

function FreeformJsonEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [raw, setRaw] = useState(() => {
    const keys = Object.keys(value);
    return keys.length > 0 ? JSON.stringify(value, null, 2) : "";
  });
  const [error, setError] = useState<string | null>(null);

  // Keep raw in sync if value changes externally
  useEffect(() => {
    const keys = Object.keys(value);
    if (keys.length > 0) {
      setRaw(JSON.stringify(value, null, 2));
    }
  }, [JSON.stringify(value)]);

  const handleChange = (text: string) => {
    setRaw(text);
    if (text.trim() === "") {
      setError(null);
      onChange({});
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("Invalid JSON: must be an object");
        return;
      }
      setError(null);
      onChange(parsed);
    } catch {
      setError("Invalid JSON");
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium mb-1">Parameters (JSON)</label>
      <p className="text-[10px] text-text-muted mb-1">
        No parameter schema defined. Enter parameters as JSON.
      </p>
      <textarea
        value={raw}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={'{\n  "key": "value"\n}'}
        rows={6}
        className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
      />
      {error && <p className="text-[10px] text-error mt-0.5">{error}</p>}
    </div>
  );
}
