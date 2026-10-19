import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import AccountPage from "./page";

const signOut = vi.fn();
vi.mock("@/store/useSignOut", () => ({ useSignOut: () => signOut }));
vi.mock("@/lib/authHeaders", () => ({ getAuthHeaders: async () => ({}) }));

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  signOut.mockReset();
  vi.unstubAllGlobals();
});

const signIn = () => {
  useAppStore.setState({
    authStatus: "signed-in",
    uid: "uid-1",
    displayName: "Jamie Rivera",
    providerId: "google.com",
  });
};

const stubFetch = (body: unknown) => {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("AccountPage", () => {
  it("renders the signed-in user's name and provider", () => {
    signIn();
    render(<AccountPage />);

    expect(screen.getByText("Jamie Rivera")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
  });

  it("gates the delete button until DELETE is typed exactly", () => {
    signIn();
    render(<AccountPage />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const confirmButton = screen.getByRole("button", {
      name: "Permanently delete my account",
    });
    const input = screen.getByPlaceholderText("DELETE");

    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "delete" } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(confirmButton).toBeEnabled();
  });

  it("shows a failure state and lets the user retry when deletion fails", async () => {
    signIn();
    stubFetch({ success: false, reason: "Server exploded" });
    render(<AccountPage />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByPlaceholderText("DELETE"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() =>
      expect(
        screen.getByText("Failed to delete account: Server exploded")
      ).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", { name: "Permanently delete my account" })
    ).toBeEnabled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs the user out on successful deletion", async () => {
    signIn();
    stubFetch({ success: true });
    render(<AccountPage />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByPlaceholderText("DELETE"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
});
