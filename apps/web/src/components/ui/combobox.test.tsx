import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { Combobox, type ComboboxOption } from "./combobox";

const BRANCHES: ComboboxOption[] = [
  { id: "main", label: "main", badge: "default" },
  { id: "release/1.0", label: "release/1.0" },
  { id: "release/1.1", label: "release/1.1" },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** A branch field: free text allowed, the list narrowed by the parent on each search. */
function BranchField({
  onSearch,
  onChange,
  options = BRANCHES,
  error,
}: {
  onSearch: (q: string) => void;
  onChange: (name: string) => void;
  options?: ComboboxOption[];
  error?: string;
}) {
  const [value, setValue] = useState("main");
  const [rows, setRows] = useState(options);
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <Combobox
        freeText
        mono
        label="Base branch"
        value={value}
        options={rows}
        error={error}
        onSearch={(q) => {
          onSearch(q);
          setRows(options.filter((o) => o.label.includes(q)));
        }}
        onPick={(o) => {
          setValue(o.label);
          onChange(o.label);
        }}
        onCommit={(text) => {
          setValue(text);
          onChange(text);
        }}
        emptyMessage={(q) => `No branch matches “${q}” — press Enter to use it as typed`}
      />
      <button type="button">elsewhere</button>
    </form>
  );
}

const box = () => screen.getByRole("combobox", { name: "Base branch" });

describe("Combobox", () => {
  it("opens on focus with every row and asks for the typed text after a pause", () => {
    const onSearch = vi.fn();
    render(<BranchField onSearch={onSearch} onChange={vi.fn()} />);

    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(box());
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onSearch).toHaveBeenLastCalledWith("");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "maindefault",
      "release/1.0",
      "release/1.1",
    ]);

    fireEvent.change(box(), { target: { value: "rel" } });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSearch).toHaveBeenLastCalledWith("rel");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("picks a row with the keyboard: ArrowDown twice, Enter", () => {
    const onChange = vi.fn();
    render(<BranchField onSearch={vi.fn()} onChange={onChange} />);
    fireEvent.focus(box());
    act(() => {
      vi.advanceTimersByTime(0);
    });

    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(box().getAttribute("aria-activedescendant")).toBe(options[1].id);

    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("release/1.0");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((box() as HTMLInputElement).value).toBe("release/1.0");
  });

  it("picks a row with the mouse", () => {
    const onChange = vi.fn();
    render(<BranchField onSearch={vi.fn()} onChange={onChange} />);
    fireEvent.focus(box());
    act(() => {
      vi.advanceTimersByTime(0);
    });
    fireEvent.click(screen.getByRole("option", { name: "release/1.1" }));
    expect(onChange).toHaveBeenCalledWith("release/1.1");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps a typed name no row has, on Enter and when focus leaves", () => {
    const onChange = vi.fn();
    render(<BranchField onSearch={vi.fn()} onChange={onChange} />);

    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "feature/new-thing" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("listbox").textContent).toContain(
      "No branch matches “feature/new-thing” — press Enter to use it as typed",
    );
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("feature/new-thing");
    expect((box() as HTMLInputElement).value).toBe("feature/new-thing");

    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "hotfix/typo" } });
    fireEvent.blur(box(), { relatedTarget: screen.getByText("elsewhere") });
    expect(onChange).toHaveBeenLastCalledWith("hotfix/typo");
  });

  it("takes an exact match over free text, and Escape closes without a change", () => {
    const onChange = vi.fn();
    render(<BranchField onSearch={vi.fn()} onChange={onChange} />);

    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "release/1.0" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("release/1.0");

    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "rel" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((box() as HTMLInputElement).value).toBe("release/1.0");
  });

  it("shows the parent's error as a hint under the rows, not instead of them", () => {
    render(
      <BranchField
        onSearch={vi.fn()}
        onChange={vi.fn()}
        options={[]}
        error="No GitLab token available"
      />,
    );
    fireEvent.focus(box());
    act(() => {
      vi.advanceTimersByTime(0);
    });
    const list = screen.getByRole("listbox");
    expect(list.textContent).toContain("No GitLab token available");
    fireEvent.change(box(), { target: { value: "x" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect((box() as HTMLInputElement).value).toBe("x");
  });

  it("without free text, Enter takes the first row and × clears a picked value", () => {
    const onPick = vi.fn();
    const onClear = vi.fn();
    render(
      <Combobox
        label="Merge request"
        value="!12 Fix login"
        options={[
          { id: "12", label: "!12 Fix login", hint: "@alice · bug/login → main" },
          { id: "13", label: "!13 Other" },
        ]}
        onSearch={vi.fn()}
        onPick={onPick}
        onClear={onClear}
      />,
    );
    const mr = () => screen.getByRole("combobox", { name: "Merge request" });
    fireEvent.click(screen.getByRole("button", { name: "Clear merge request" }));
    expect(onClear).toHaveBeenCalledTimes(1);

    fireEvent.focus(mr());
    fireEvent.change(mr(), { target: { value: "13" } });
    fireEvent.keyDown(mr(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "12" }));
  });
});
