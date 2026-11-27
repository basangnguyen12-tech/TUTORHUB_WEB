import { TooltipProvider } from "@tutorhub/ui";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../app/i18n";
import { getVisibleNavigationItems, type NavigationItem } from "../app/routes";
import {
  AppSidebar,
  SIDEBAR_COLLAPSED_KEY,
  WorkspaceSwitcher,
  type AppSidebarProps,
} from "./AppSidebar";

const adminItems = getVisibleNavigationItems(["tenant.view"]);
const studentItems = getVisibleNavigationItems([]);
const tenantlessItems = getVisibleNavigationItems([], {
  hasActiveTenant: false,
});

function renderWithProviders(ui: ReactElement, path = "/app/home") {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
}

function renderSidebar(
  props: Partial<AppSidebarProps> = {},
  path = "/app/home",
) {
  const onClose = vi.fn();
  const view = renderWithProviders(
    <AppSidebar
      displayName="Nguyễn Văn An"
      isCompact={false}
      isOpen={false}
      items={adminItems}
      onClose={onClose}
      roleLabel="Giáo viên"
      workspaceSwitcher={<div data-testid="workspace-switcher" />}
      {...props}
    />,
    path,
  );
  return { ...view, onClose };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function navigationLinkTexts() {
  return within(screen.getByRole("navigation", { name: "Điều hướng chính" }))
    .getAllByRole("link")
    .map((link) => link.textContent);
}

describe("AppSidebar grouping", () => {
  it("keeps route order across the overview, learning and manage groups", () => {
    renderSidebar();

    expect(navigationLinkTexts()).toEqual([
      "Tổng quan",
      "Lớp học",
      "Tin nhắn",
      "Lịch",
      "Workspace",
      "Thiết lập",
    ]);
    const manage = screen.getByRole("group", { name: "Quản lý" });
    expect(
      within(manage)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Workspace", "Thiết lập"]);
  });

  it("keeps the manage group for a student with only account settings", () => {
    renderSidebar({ items: studentItems });

    const manage = screen.getByRole("group", { name: "Quản lý" });
    expect(
      within(manage)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Thiết lập"]);
  });

  it("puts an item no group claims into the first, unlabelled group", () => {
    const extra: NavigationItem = { to: "/app/tasks", labelKey: "nav.tasks" };
    renderSidebar({ items: [...studentItems, extra] });

    expect(navigationLinkTexts()).toEqual([
      "Tổng quan",
      "Nhiệm vụ",
      "Lớp học",
      "Tin nhắn",
      "Lịch",
      "Thiết lập",
    ]);
  });
});

describe("AppSidebar", () => {
  it("renders labelled groups and marks the current page", () => {
    renderSidebar({}, "/app/classrooms");

    const navigation = screen.getByRole("navigation", {
      name: "Điều hướng chính",
    });
    expect(within(navigation).getAllByRole("link")).toHaveLength(6);
    const learning = within(navigation).getByRole("group", {
      name: "Học tập",
    });
    expect(
      within(learning)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Lớp học", "Tin nhắn", "Lịch"]);
    expect(
      within(navigation).getByRole("group", { name: "Quản lý" }),
    ).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: "Lớp học" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(navigation).getByRole("link", { name: "Tổng quan" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("hides a group label together with its filtered-out items", () => {
    renderSidebar({ items: tenantlessItems });

    const navigation = screen.getByRole("navigation", {
      name: "Điều hướng chính",
    });
    expect(
      within(navigation).queryByRole("group", { name: "Học tập" }),
    ).toBeNull();
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Thiết lập"]);
  });

  it("collapses to an icon rail, keeps accessible names and remembers it", () => {
    const { unmount } = renderSidebar();

    const collapse = screen.getByRole("button", { name: "Thu gọn thanh bên" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);

    const expand = screen.getByRole("button", { name: "Mở rộng thanh bên" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("complementary", { name: "Điều hướng chính" }),
    ).toHaveClass("app-sidebar--collapsed");
    const overview = screen.getByRole("link", { name: "Tổng quan" });
    expect(overview).toHaveAttribute("aria-current", "page");
    expect(overview).toHaveClass("app-navigation__link");
    expect(overview.className).not.toContain("=>");
    expect(screen.getByRole("link", { name: "Lịch" })).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");

    unmount();
    renderSidebar();
    expect(
      screen.getByRole("complementary", { name: "Điều hướng chính" }),
    ).toHaveClass("app-sidebar--collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Mở rộng thanh bên" }));
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "Điều hướng chính" }),
    ).not.toHaveClass("app-sidebar--collapsed");
  });

  it("falls back to expanded when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      renderSidebar();
      expect(
        screen.getByRole("complementary", { name: "Điều hướng chính" }),
      ).not.toHaveClass("app-sidebar--collapsed");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("never collapses the mobile drawer", () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    renderSidebar({ isCompact: true, isOpen: true });

    expect(
      screen.getByRole("complementary", { name: "Điều hướng chính" }),
    ).not.toHaveClass("app-sidebar--collapsed");
  });

  it("focuses the drawer and closes it with Escape or the backdrop", () => {
    const { onClose } = renderSidebar({ isCompact: true, isOpen: true });

    expect(
      screen.getByRole("button", { name: "Đóng điều hướng" }),
    ).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId("app-sidebar-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("link", { name: "Lịch" }));
    expect(onClose).toHaveBeenLastCalledWith(false);
  });

  it("ignores Escape and shows no backdrop on desktop", () => {
    const { onClose } = renderSidebar({ isOpen: true });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("app-sidebar-backdrop")).toBeNull();
  });

  it("links the identity footer to account settings", () => {
    renderSidebar();

    const footer = screen.getByRole("link", { name: /Nguyễn Văn An/ });
    expect(footer).toHaveAttribute("href", "/app/settings");
    expect(footer).toHaveAttribute("title", "Thiết lập tài khoản");
    expect(footer.querySelector(".app-sidebar__avatar")).toHaveTextContent(
      "NA",
    );
  });
});

describe("WorkspaceSwitcher", () => {
  const first = { id: "tenant-1", name: "Trung tâm A" };
  const second = { id: "tenant-2", name: "Trung tâm B" };

  it("shows a read-only name when only one workspace exists", () => {
    renderWithProviders(
      <WorkspaceSwitcher
        activeTenant={first}
        isPending={false}
        onSelect={vi.fn()}
        options={[first]}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Trung tâm A")).toBeInTheDocument();
    const logo = document.querySelector("img.app-switcher__logo");
    expect(logo).toHaveAttribute("src", "/images/brand/tutorhub-logo-64.png");
    expect(logo).toHaveAttribute("alt", "");
  });

  it("switches through the native select and locks it while pending", () => {
    const onSelect = vi.fn();
    const { rerender } = renderWithProviders(
      <WorkspaceSwitcher
        activeTenant={first}
        isPending={false}
        onSelect={onSelect}
        options={[first, second]}
      />,
    );

    const select = screen.getByRole("combobox", {
      name: "Workspace đang hoạt động",
    });
    expect(select).toHaveValue("tenant-1");
    fireEvent.change(select, { target: { value: "tenant-2" } });
    expect(onSelect).toHaveBeenCalledWith("tenant-2");

    rerender(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter>
            <WorkspaceSwitcher
              activeTenant={first}
              isPending
              onSelect={onSelect}
              options={[first, second]}
            />
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );
    const pendingSelect = screen.getByRole("combobox", {
      name: "Workspace đang hoạt động",
    });
    expect(pendingSelect).toBeDisabled();
    expect(pendingSelect).toHaveAttribute("aria-busy", "true");
  });

  it("links to the workspace chooser when no workspace is active", () => {
    renderWithProviders(
      <WorkspaceSwitcher
        activeTenant={null}
        isPending={false}
        onSelect={vi.fn()}
        options={[]}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Chọn hoặc tạo workspace" }),
    ).toHaveAttribute("href", "/app/home");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
