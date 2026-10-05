import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/lib/api-client", () => ({
  api: { listRepos: () => Promise.resolve({ repos: [] }) },
}));

import { ProviderFields, requiredMissing, type ConfigSchema } from "./provider-fields";

afterEach(() => cleanup());

const SCHEMA: ConfigSchema = {
  properties: {
    token: { type: "string", title: "API token", format: "secret" },
    region: {
      type: "string",
      title: "Region",
      enum: ["us", "eu"],
      enumTitles: ["United States", "Europe"],
      default: "us",
    },
    readOnly: { type: "boolean", title: "Read only", default: true },
  },
  required: ["token", "region"],
};

describe("ProviderFields", () => {
  it("renders a secret as a password input with a show/hide toggle", () => {
    const onChange = vi.fn();
    render(<ProviderFields schema={SCHEMA} value={{}} onChange={onChange} mode="create" />);
    const input = screen.getByLabelText(/API token/) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show value" }));
    expect(input.type).toBe("text");
    fireEvent.change(input, { target: { value: "sk-1" } });
    expect(onChange).toHaveBeenCalledWith({ token: "sk-1" });
  });

  it("renders an enum as a select labelled by enumTitles", () => {
    render(<ProviderFields schema={SCHEMA} value={{}} onChange={vi.fn()} mode="create" />);
    const select = screen.getByLabelText(/Region/) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "United States",
      "Europe",
    ]);
    expect(select.value).toBe("us");
    expect(screen.getByRole("switch", { name: "Read only" })).toBeInTheDocument();
  });

  it("shows a saved secret as a masked line with a Replace link in edit mode", () => {
    render(
      <ProviderFields
        schema={SCHEMA}
        value={{ region: "eu" }}
        onChange={vi.fn()}
        secretFields={["token"]}
        mode="edit"
      />,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByLabelText(/API token/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Replace"));
    expect((screen.getByLabelText(/API token/) as HTMLInputElement).type).toBe("password");
  });
});

describe("requiredMissing", () => {
  it("lists required keys without a value; a saved secret counts as present", () => {
    expect(requiredMissing(SCHEMA, {})).toEqual(["token", "region"]);
    expect(requiredMissing(SCHEMA, { token: " ", region: "eu" })).toEqual(["token"]);
    expect(requiredMissing(SCHEMA, { region: "eu" }, ["token"])).toEqual([]);
    expect(requiredMissing(SCHEMA, { token: "x", region: "us" })).toEqual([]);
    expect(requiredMissing(null, {})).toEqual([]);
  });
});
