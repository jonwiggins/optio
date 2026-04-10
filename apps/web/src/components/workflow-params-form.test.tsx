import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WorkflowParamsForm } from "./workflow-params-form";

afterEach(() => {
  cleanup();
});

describe("WorkflowParamsForm", () => {
  describe("with paramsSchema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
        count: { type: "number", description: "Number of items" },
        verbose: { type: "boolean", description: "Enable verbose logging" },
        env: {
          type: "string",
          enum: ["dev", "staging", "production"],
          description: "Target environment",
        },
      },
      required: ["name"],
    };

    it("renders a text input for string fields", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
      const input = screen.getByLabelText(/name/i) as HTMLInputElement;
      expect(input.type).toBe("text");
    });

    it("renders a number input for number fields", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      expect(screen.getByLabelText(/count/i)).toBeInTheDocument();
      const input = screen.getByLabelText(/count/i) as HTMLInputElement;
      expect(input.type).toBe("number");
    });

    it("renders a checkbox for boolean fields", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      expect(screen.getByLabelText(/verbose/i)).toBeInTheDocument();
      const input = screen.getByLabelText(/verbose/i) as HTMLInputElement;
      expect(input.type).toBe("checkbox");
    });

    it("renders a select for enum fields", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      expect(screen.getByLabelText(/env/i)).toBeInTheDocument();
      const select = screen.getByLabelText(/env/i) as HTMLSelectElement;
      expect(select.tagName).toBe("SELECT");
      // Should have the three options plus an empty default
      expect(select.options.length).toBe(4);
    });

    it("shows description text for fields", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      expect(screen.getByText("Your name")).toBeInTheDocument();
      expect(screen.getByText("Number of items")).toBeInTheDocument();
    });

    it("marks required fields", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      // The name field label should have the required indicator
      const nameLabel = screen.getByText("name");
      const parent = nameLabel.closest("label") ?? nameLabel.parentElement;
      expect(parent?.textContent).toContain("*");
    });

    it("calls onChange when a string field is typed into", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      const input = screen.getByLabelText(/name/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Alice" } });
      expect(onChange).toHaveBeenCalledWith({ name: "Alice" });
    });

    it("calls onChange when a number field changes", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      const input = screen.getByLabelText(/count/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "42" } });
      expect(onChange).toHaveBeenCalledWith({ count: 42 });
    });

    it("calls onChange when a boolean field is toggled", () => {
      const onChange = vi.fn();
      render(
        <WorkflowParamsForm paramsSchema={schema} value={{ verbose: false }} onChange={onChange} />,
      );
      const checkbox = screen.getByLabelText(/verbose/i) as HTMLInputElement;
      fireEvent.click(checkbox);
      expect(onChange).toHaveBeenCalledWith({ verbose: true });
    });

    it("calls onChange when an enum field is selected", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      const select = screen.getByLabelText(/env/i) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "staging" } });
      expect(onChange).toHaveBeenCalledWith({ env: "staging" });
    });

    it("renders with pre-filled values", () => {
      const onChange = vi.fn();
      render(
        <WorkflowParamsForm
          paramsSchema={schema}
          value={{ name: "Bob", count: 5, verbose: true, env: "production" }}
          onChange={onChange}
        />,
      );
      expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe("Bob");
      expect((screen.getByLabelText(/count/i) as HTMLInputElement).value).toBe("5");
      expect((screen.getByLabelText(/verbose/i) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText(/env/i) as HTMLSelectElement).value).toBe("production");
    });

    it("uses default values from the schema", () => {
      const schemaWithDefaults = {
        type: "object",
        properties: {
          branch: { type: "string", default: "main" },
          retries: { type: "number", default: 3 },
        },
      };
      const onChange = vi.fn();
      render(
        <WorkflowParamsForm paramsSchema={schemaWithDefaults} value={{}} onChange={onChange} />,
      );
      expect((screen.getByLabelText(/branch/i) as HTMLInputElement).value).toBe("main");
      expect((screen.getByLabelText(/retries/i) as HTMLInputElement).value).toBe("3");
    });
  });

  describe("without paramsSchema (freeform JSON)", () => {
    it("renders a textarea for freeform JSON input", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={null} value={{}} onChange={onChange} />);
      const textarea = screen.getByRole("textbox");
      expect(textarea.tagName).toBe("TEXTAREA");
    });

    it("shows placeholder text for JSON input", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={null} value={{}} onChange={onChange} />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(textarea.placeholder).toContain("{");
    });

    it("calls onChange with parsed JSON when valid", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={null} value={{}} onChange={onChange} />);
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: '{"key": "value"}' } });
      expect(onChange).toHaveBeenCalledWith({ key: "value" });
    });

    it("shows an error for invalid JSON", () => {
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={null} value={{}} onChange={onChange} />);
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "not json" } });
      expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
    });

    it("renders existing value as formatted JSON", () => {
      const onChange = vi.fn();
      render(
        <WorkflowParamsForm paramsSchema={null} value={{ hello: "world" }} onChange={onChange} />,
      );
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(textarea.value).toContain('"hello"');
      expect(textarea.value).toContain('"world"');
    });
  });

  describe("with empty schema properties", () => {
    it("renders freeform JSON when schema has no properties", () => {
      const onChange = vi.fn();
      render(
        <WorkflowParamsForm paramsSchema={{ type: "object" }} value={{}} onChange={onChange} />,
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea.tagName).toBe("TEXTAREA");
    });
  });

  describe("with integer type", () => {
    it("renders a number input for integer fields", () => {
      const schema = {
        type: "object",
        properties: {
          retries: { type: "integer", description: "Retry count" },
        },
      };
      const onChange = vi.fn();
      render(<WorkflowParamsForm paramsSchema={schema} value={{}} onChange={onChange} />);
      const input = screen.getByLabelText(/retries/i) as HTMLInputElement;
      expect(input.type).toBe("number");
    });
  });
});
