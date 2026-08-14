import { useState } from "react";
import { useUser, useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLinkAccount, getGetLinkStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Link2, LogOut } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function LinkWhatsApp() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const linkMutation = useLinkAccount();
  const [code, setCode] = useState("");

  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  const handleLink = () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      toast({ title: "Enter your link code", variant: "destructive" });
      return;
    }
    linkMutation.mutate(
      { data: { code: trimmed } },
      {
        onSuccess: () => {
          toast({ title: "WhatsApp linked!", description: "Loading your dashboard…" });
          queryClient.invalidateQueries({ queryKey: getGetLinkStatusQueryKey() });
        },
        onError: (error) => {
          if (error.status === 409) {
            toast({
              title: "Account already linked",
              description:
                "This dashboard account is linked to a different WhatsApp. Unlink it first, then try again.",
              variant: "destructive",
            });
          } else {
            toast({
              title: "Invalid or expired code",
              description: "Send /link to your WADash Telegram bot to get a fresh code.",
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground">
            <MessageSquare size={24} />
          </div>
          <CardTitle className="text-2xl">Connect your WhatsApp</CardTitle>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{email}</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">How to get your code</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Open your WADash bot in Telegram</li>
              <li>
                Send <code className="px-1 py-0.5 rounded bg-muted text-foreground">/link</code>
              </li>
              <li>Paste the one-time code below (it expires in ~10 minutes)</li>
            </ol>
          </div>

          <div className="space-y-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleLink();
              }}
              placeholder="e.g. K7Q3M9XP"
              autoComplete="one-time-code"
              className="text-center text-lg tracking-widest font-mono uppercase"
              data-testid="input-link-code"
            />
            <Button
              className="w-full"
              onClick={handleLink}
              disabled={linkMutation.isPending}
              data-testid="button-link"
            >
              <Link2 size={16} className="mr-2" />
              {linkMutation.isPending ? "Linking…" : "Link WhatsApp"}
            </Button>
          </div>

          <div className="pt-2 border-t border-border text-center">
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: basePath || "/" })}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-sign-out"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
