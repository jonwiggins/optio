import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DeploymentShareTag } from "./deployment-share";

afterEach(cleanup);

describe("DeploymentShareTag", () => {
  it("shows nothing for a workspace's own row", () => {
    const { container } = render(
      <DeploymentShareTag row={{ workspaceId: "ws-1" }} canShare onShare={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("tells everyone whether a deployment row is shared, read-only for non-admins", () => {
    render(
      <DeploymentShareTag
        row={{ workspaceId: null, deploymentDefault: true }}
        canShare={false}
        onShare={vi.fn()}
      />,
    );
    expect(screen.getByText("Deployment · every workspace")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lets a deployment admin share an unshared deployment row, and stop again", async () => {
    const onShare = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <DeploymentShareTag
        row={{ workspaceId: null, deploymentDefault: false }}
        canShare
        onShare={onShare}
      />,
    );
    const share = screen.getByRole("button", { name: "Share with every workspace" });
    expect(share).toHaveTextContent("Deployment · founding workspace");
    fireEvent.click(share);
    await waitFor(() => expect(onShare).toHaveBeenCalledWith(true));

    rerender(
      <DeploymentShareTag
        row={{ deployment: true, deploymentDefault: true }}
        canShare
        onShare={onShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with every workspace" }));
    await waitFor(() => expect(onShare).toHaveBeenCalledWith(false));
  });
});
