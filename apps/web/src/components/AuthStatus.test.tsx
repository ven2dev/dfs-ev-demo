import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { signInWithPopup } from "firebase/auth";
import { useAppStore } from "@/store";
import { AuthStatus } from "./AuthStatus";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("firebase/auth", () => ({ signInWithPopup: vi.fn() }));
vi.mock("@/lib/firebaseClient", () => ({
  getFirebaseAuth: () => ({}),
  googleProvider: {},
}));

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  vi.mocked(signInWithPopup).mockReset();
  vi.restoreAllMocks();
});

const signIn = (displayName: string | null = "Jamie Rivera") => {
  useAppStore.setState({
    authStatus: "signed-in",
    uid: "uid-1",
    displayName,
    providerId: "google.com",
  });
};

describe("AuthStatus avatar menu", () => {
  it("renders an accessible, closed menu button when signed in", () => {
    signIn();
    render(<AuthStatus />);

    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu on click, showing the display name and menu items", () => {
    signIn();
    render(<AuthStatus />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

    expect(screen.getByRole("button", { name: "Account menu" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Jamie Rivera");
    expect(screen.getByRole("menuitem", { name: "Account" })).toHaveAttribute(
      "href",
      "/account"
    );
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("closes the menu on an outside click", () => {
    signIn();
    render(<AuthStatus />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on Escape", () => {
    signIn();
    render(<AuthStatus />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("AuthStatus sign-in feedback", () => {
  const attempt = async (error: unknown) => {
    useAppStore.setState({ authStatus: "signed-out", authError: null });
    vi.mocked(signInWithPopup).mockRejectedValueOnce(error);
    render(<AuthStatus />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    });
  };

  it.each(["auth/popup-closed-by-user", "auth/cancelled-popup-request"])(
    "treats %s as cancellation, leaving sign-in available without a failure log",
    async (code) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await attempt({ code });
      expect(useAppStore.getState().authError).toBeNull();
      expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["auth/popup-blocked", "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."],
    ["auth/network-request-failed", "Could not connect to sign in. Check your connection and try again."],
    ["auth/unauthorized-domain", "Sign-in failed. Try again."],
    ["auth/unrecognized-error", "Sign-in failed. Try again."],
  ])("shows actionable feedback for %s and logs the failure", async (code, message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = { code };
    await attempt(error);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(log).toHaveBeenCalledWith("[AuthStatus] sign-in failed:", error);
  });

  it.each([null, "unexpected rejection"])("handles an uncoded rejection: %s", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await attempt(error);
    expect(screen.getByText("Sign-in failed. Try again.")).toBeInTheDocument();
    expect(log).toHaveBeenCalledWith("[AuthStatus] sign-in failed:", error);
  });

  it("clears the previous message immediately when another attempt starts", () => {
    useAppStore.setState({ authStatus: "signed-out", authError: "Sign-in failed. Try again." });
    vi.mocked(signInWithPopup).mockImplementationOnce(() => new Promise(() => {}));
    render(<AuthStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(screen.queryByText("Sign-in failed. Try again.")).not.toBeInTheDocument();
    expect(useAppStore.getState().authError).toBeNull();
  });

  it("does not let a superseded popup cancellation erase a newer failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useAppStore.setState({ authStatus: "signed-out", authError: null });
    let cancelFirst!: (error: unknown) => void;
    vi.mocked(signInWithPopup)
      .mockImplementationOnce(() => new Promise((_, reject) => { cancelFirst = reject; }))
      .mockRejectedValueOnce({ code: "auth/popup-blocked" });
    render(<AuthStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    });
    await act(async () => { cancelFirst({ code: "auth/cancelled-popup-request" }); });
    expect(screen.getByText(/Your browser blocked the sign-in window/)).toBeInTheDocument();
  });
});
