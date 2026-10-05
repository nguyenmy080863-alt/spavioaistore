import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchTickets } from "@/lib/warranty";
import { fetchSalesOrders } from "@/lib/orders";
import { fetchReturns } from "@/lib/returns";
import { useAdminAuth, ROLE_LABELS } from "@/context/AdminAuthContext";
import { Button } from "@/components/ui/button";
import StoreLogo from "@/components/StoreLogo";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { adminDocsNav, adminNav, adminOverview, adminSettingsNav, type AdminNavSection } from "./adminNav";

const AdminLayout = () => {
  const { user, isAdmin, loading, roles, signOut } = useAdminAuth();
  const location = useLocation();

  // Items waiting for the team, shown as a badge on the sidebar item. Each query shares its cache with its page.
  const poll = { enabled: isAdmin, refetchInterval: 60_000 };
  const { data: tickets = [] } = useQuery({ queryKey: ["warranty-tickets"], queryFn: fetchTickets, ...poll });
  const { data: orders = [] } = useQuery({ queryKey: ["sales-orders"], queryFn: fetchSalesOrders, ...poll });
  const { data: returns = [] } = useQuery({ queryKey: ["returns"], queryFn: fetchReturns, ...poll });
  const pending: Record<string, number> = {
    "/admin/warranty": tickets.filter((t) => t.status === "open").length,
    "/admin/orders": orders.filter((o) => o.status === "open" && o.payment_status === "paid").length,
    "/admin/returns": returns.filter((r) => r.status === "requested").length,
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          This account ({user.email}) has no admin role yet.
        </p>
        <div className="flex gap-3">
          <Button variant="outline" size="sm" asChild>
            <Link to="/">Back to shop</Link>
          </Button>
          <Button size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }


  const path = location.pathname.replace(/\/$/, "");
  const isIn = (to: string) => path === to || path.startsWith(`${to}/`);
  // Settings has no page of its own, so it is active only through its children.
  const sectionActive = (section: AdminNavSection) =>
    isIn(section.to) || (section.children ?? []).some((child) => isIn(child.to));

  const renderSection = (section: AdminNavSection) => {
    const Icon = section.icon;
    const active = sectionActive(section);

    if (!section.children) {
      return (
        <SidebarMenuItem key={section.to}>
          <SidebarMenuButton asChild isActive={active} tooltip={section.title}>
            <Link to={section.to}>
              <Icon />
              <span>{section.title}</span>
            </Link>
          </SidebarMenuButton>
          {pending[section.to] > 0 && <SidebarMenuBadge className="rounded-full bg-primary px-0 text-[0.65rem] text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground">{pending[section.to]}</SidebarMenuBadge>}
        </SidebarMenuItem>
      );
    }

    return (
      <Collapsible key={section.to} asChild open={active} className="group/collapsible">
        <SidebarMenuItem>
          <SidebarMenuButton asChild isActive={path === section.to} tooltip={section.title}>
            <Link to={section.to}>
              <Icon />
              <span>{section.title}</span>
            </Link>
          </SidebarMenuButton>
          {pending[section.to] > 0 && <SidebarMenuBadge className="right-7 rounded-full bg-primary px-0 text-[0.65rem] text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground">{pending[section.to]}</SidebarMenuBadge>}
          <ChevronRight className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90" />
          <CollapsibleContent>
            <SidebarMenuSub>
              {section.children.map((child) => (
                <SidebarMenuSubItem key={child.to}>
                  <SidebarMenuSubButton asChild isActive={isIn(child.to)}>
                    <Link to={child.to}>
                      <span>{child.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  };

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="h-16 justify-center px-4 border-b border-sidebar-border">
          <Link to="/">
            <StoreLogo heightClass="h-6" />
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={path === adminOverview.to} tooltip={adminOverview.title}>
                  <Link to={adminOverview.to}>
                    <adminOverview.icon />
                    <span>{adminOverview.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {adminNav.map(renderSection)}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarMenu>
              {renderSection(adminDocsNav)}
              {renderSection(adminSettingsNav)}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="bg-background">
        <header className="flex items-center justify-between px-6 h-16 border-b border-border">
          <SidebarTrigger />
          <div className="flex items-center gap-4">
            <div className="hidden sm:block text-right">
              <p className="text-xs text-foreground">{user.email}</p>
              <p className="text-[0.65rem] text-muted-foreground">
                {roles.map((role) => ROLE_LABELS[role]).join(" · ")}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="px-6 py-10 max-w-6xl w-full mx-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default AdminLayout;
