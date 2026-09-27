import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useAppStore } from "@/store";
import { AuthStatus } from "./AuthStatus";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
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
