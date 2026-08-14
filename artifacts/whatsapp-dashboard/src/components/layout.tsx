import React from "react";
import { Link, useLocation } from "wouter";
import {
  MessageSquare,
  LayoutDashboard,
  Repeat,
  Radio,
  Clock,
  Users,
  Menu,
  LogOut,
  Link2Off,
  Settings,
  ShieldAlert
} from "lucide-react";
import { useUser, useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { useUnlinkAccount, getGetLinkStatusQueryKey } from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const navItems = [
  { href: "/app", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/messages", label: "Message Log", icon: MessageSquare },
  { href: "/app/captures", label: "Captured Messages", icon: ShieldAlert },
  { href: "/app/auto-reply", label: "Auto-Reply", icon: Repeat },
  { href: "/app/broadcasts", label: "Broadcasts", icon: Radio },
  { href: "/app/statuses", label: "Scheduled Status", icon: Clock },
  { href: "/app/groups", label: "Groups & Moderation", icon: Users },
];

function UserFooter() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const unlinkMutation = useUnlinkAccount();

  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const name = user?.fullName ?? email;
  const initials = (name || email || "?").slice(0, 2).toUpperCase();

  const handleUnlink = () => {
    unlinkMutation.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "WhatsApp unlinked", description: "Your dashboard is no longer connected." });
        queryClient.invalidateQueries({ queryKey: getGetLinkStatusQueryKey() });
      },
      onError: () => toast({ title: "Couldn't unlink", variant: "destructive" }),
    });
  };

  return (
    <div className="p-4 border-t border-sidebar-border space-y-3">
      <div className="flex items-center gap-3 px-1">
        <div className="w-9 h-9 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-sidebar-foreground truncate" data-testid="text-user-name">
            {name}
          </p>
          {email && name !== email && (
            <p className="text-xs text-sidebar-foreground/60 truncate">{email}</p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={handleUnlink}
          disabled={unlinkMutation.isPending}
          data-testid="button-unlink"
        >
          <Link2Off size={15} className="mr-1.5" />
          Unlink
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1"
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
          data-testid="button-logout"
        >
          <LogOut size={15} className="mr-1.5" />
          Log out
        </Button>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      <div className="p-6">
        <h2 className="text-xl font-bold tracking-tight text-sidebar-foreground flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground">
            <MessageSquare size={18} />
          </div>
          WADash
        </h2>
      </div>
      <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                }`}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <Icon size={18} />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      <UserFooter />
    </div>
  );

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Desktop Sidebar */}
      <div className="hidden md:block w-64 flex-shrink-0">
        <SidebarContent />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Header */}
        <header className="md:hidden h-14 border-b flex items-center px-4 justify-between bg-background z-10">
          <div className="font-bold flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center text-primary-foreground">
              <MessageSquare size={14} />
            </div>
            WADash
          </div>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" data-testid="mobile-menu-btn">
                <Menu size={20} />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64">
              <SidebarContent />
            </SheetContent>
          </Sheet>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
