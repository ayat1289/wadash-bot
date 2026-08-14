import React, { useState } from "react";
import {
  useGetWhatsappStatus,
  useGetDashboardStats,
  useConnectWhatsapp,
  useDisconnectWhatsapp,
  useRequestWhatsappPairingCode,
  getGetWhatsappStatusQueryKey,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  MessageCircle,
  Activity,
  Zap,
  Radio,
  Users,
  Smartphone,
  CheckCircle2,
  RefreshCw,
  QrCode,
  Hash,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type LinkMode = "qr" | "pair";

export default function Dashboard() {
  const { data: status, isLoading: statusLoading } = useGetWhatsappStatus({
    query: { queryKey: getGetWhatsappStatusQueryKey(), refetchInterval: 3000 },
  });

  const { data: stats, isLoading: statsLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey(), refetchInterval: 10000 },
  });

  const connectMutation = useConnectWhatsapp();
  const disconnectMutation = useDisconnectWhatsapp();
  const pairMutation = useRequestWhatsappPairingCode();
  const { toast } = useToast();

  const [linkMode, setLinkMode] = useState<LinkMode>("qr");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const handleConnect = () => {
    setPairingCode(null);
    connectMutation.mutate(undefined, {
      onSuccess: () => toast({ title: "Connecting… scan the QR code" }),
      onError: (err) =>
        toast({ title: "Connection failed", description: String(err), variant: "destructive" }),
    });
  };

  const handleRequestCode = () => {
    if (!phoneNumber.trim()) {
      toast({ title: "Enter your phone number first", variant: "destructive" });
      return;
    }
    setPairingCode(null);
    pairMutation.mutate(
      { data: { phoneNumber: phoneNumber.replace(/[^0-9]/g, "") } },
      {
        onSuccess: (data) => {
          setPairingCode(data.code);
          toast({ title: "Pairing code ready — enter it in WhatsApp" });
        },
        onError: (err) =>
          toast({ title: "Failed to get pairing code", description: String(err), variant: "destructive" }),
      }
    );
  };

  const handleDisconnect = () => {
    setPairingCode(null);
    disconnectMutation.mutate(undefined, {
      onSuccess: () => toast({ title: "Disconnected from WhatsApp" }),
    });
  };

  const formatCode = (code: string) =>
    code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mission Control</h1>
          <p className="text-muted-foreground mt-1">Real-time overview of your WhatsApp automation.</p>
        </div>

        <div className="flex items-center gap-2">
          {statusLoading ? (
            <Skeleton className="h-9 w-32" />
          ) : (
            <Badge
              variant={
                status?.state === "connected"
                  ? "default"
                  : status?.state === "connecting"
                  ? "secondary"
                  : "destructive"
              }
              className="px-3 py-1 text-sm font-medium"
            >
              <span className="flex items-center gap-1.5">
                {status?.state === "connected" && <CheckCircle2 size={14} />}
                {status?.state === "connecting" && <RefreshCw size={14} className="animate-spin" />}
                {status?.state === "disconnected" && <Zap size={14} />}
                {status?.state === "connected"
                  ? "Connected"
                  : status?.state === "connecting"
                  ? "Connecting..."
                  : "Disconnected"}
              </span>
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="col-span-1 md:col-span-2">
          <CardHeader>
            <CardTitle>Connection Status</CardTitle>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : status?.state === "connected" ? (
              <div className="flex flex-col md:flex-row items-center gap-6 py-4">
                <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Smartphone className="w-10 h-10 text-primary" />
                </div>
                <div className="flex-1 text-center md:text-left space-y-1">
                  <h3 className="text-xl font-bold">{status?.profileName || "WhatsApp Bot"}</h3>
                  <p className="text-muted-foreground">{status?.phoneNumber || "Phone number hidden"}</p>
                  <p className="text-sm text-green-600 font-medium flex items-center justify-center md:justify-start gap-1 mt-2">
                    <CheckCircle2 size={16} /> Active & Routing Messages
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={disconnectMutation.isPending}
                >
                  Disconnect
                </Button>
              </div>
            ) : status?.state === "connecting" && !status.qrCode ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <RefreshCw className="w-12 h-12 text-primary animate-spin" />
                <p className="text-muted-foreground font-medium">Establishing connection…</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 space-y-5">
                {/* Mode toggle */}
                <div className="flex rounded-lg border p-1 gap-1 bg-muted/30">
                  <button
                    onClick={() => { setLinkMode("qr"); setPairingCode(null); }}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      linkMode === "qr"
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <QrCode size={15} /> QR Code
                  </button>
                  <button
                    onClick={() => { setLinkMode("pair"); setPairingCode(null); }}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      linkMode === "pair"
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Hash size={15} /> Phone Number
                  </button>
                </div>

                {linkMode === "qr" ? (
                  <>
                    {status?.qrCode ? (
                      <div className="bg-white p-4 rounded-xl shadow-sm border">
                        <img src={status.qrCode} alt="WhatsApp QR Code" className="w-48 h-48" />
                      </div>
                    ) : (
                      <div className="w-48 h-48 bg-muted rounded-xl flex items-center justify-center">
                        <QrCode className="w-12 h-12 text-muted-foreground opacity-40" />
                      </div>
                    )}
                    <div className="text-center space-y-1">
                      <h3 className="font-semibold text-lg">Scan to Connect</h3>
                      <p className="text-muted-foreground text-sm max-w-xs">
                        Open WhatsApp → tap <strong>Linked Devices</strong> → <strong>Link a Device</strong> → scan.
                      </p>
                    </div>
                    <Button
                      onClick={handleConnect}
                      disabled={connectMutation.isPending}
                      size="lg"
                      className="w-full max-w-xs"
                    >
                      {connectMutation.isPending ? "Generating QR…" : "Generate QR Code"}
                    </Button>
                  </>
                ) : (
                  <>
                    {pairingCode ? (
                      <div className="flex flex-col items-center gap-3">
                        <div className="bg-primary/5 border-2 border-primary/20 rounded-2xl px-10 py-6 text-center">
                          <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wider">
                            Your pairing code
                          </p>
                          <p className="text-4xl font-mono font-bold tracking-widest text-primary">
                            {formatCode(pairingCode)}
                          </p>
                        </div>
                        <p className="text-sm text-muted-foreground text-center max-w-xs">
                          Open WhatsApp → <strong>Linked Devices</strong> → <strong>Link with phone number</strong> → enter the code above.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setPairingCode(null); setPhoneNumber(""); }}
                        >
                          Try a different number
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="w-48 h-20 flex items-center justify-center">
                          <Smartphone className="w-12 h-12 text-muted-foreground opacity-40" />
                        </div>
                        <div className="text-center space-y-1">
                          <h3 className="font-semibold text-lg">Link with Phone Number</h3>
                          <p className="text-muted-foreground text-sm max-w-xs">
                            Enter your WhatsApp number and we'll give you a code to enter in the app.
                          </p>
                        </div>
                        <div className="flex gap-2 w-full max-w-xs">
                          <Input
                            placeholder="e.g. 911234567890"
                            value={phoneNumber}
                            onChange={(e) => setPhoneNumber(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleRequestCode()}
                            className="font-mono"
                          />
                          <Button
                            onClick={handleRequestCode}
                            disabled={pairMutation.isPending}
                          >
                            {pairMutation.isPending ? <RefreshCw size={16} className="animate-spin" /> : "Get Code"}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Include country code, no spaces or dashes (e.g. 911234567890 for India)
                        </p>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Quick Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {statsLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)
            ) : (
              <>
                <StatRow icon={<MessageCircle size={16} />} label="Total Messages" value={stats?.totalMessages ?? 0} />
                <StatRow icon={<Zap size={16} />} label="Active Rules" value={stats?.activeRules ?? 0} />
                <StatRow icon={<Radio size={16} />} label="Broadcasts Sent" value={stats?.broadcastsSent ?? 0} />
                <StatRow icon={<Users size={16} />} label="Groups Managed" value={stats?.groupsManaged ?? 0} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : stats?.recentActivity && stats.recentActivity.length > 0 ? (
            <div className="space-y-4">
              {stats.recentActivity.map((activity) => (
                <div
                  key={activity.id}
                  className="flex items-start gap-4 p-3 rounded-lg border bg-card/50 hover:bg-muted/50 transition-colors"
                >
                  <div className="mt-0.5 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-primary">
                    <Activity size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{activity.description}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(activity.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <Badge variant="outline" className="capitalize text-xs">
                    {activity.type.replace("_", " ")}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="w-12 h-12 mx-auto opacity-20 mb-3" />
              <p>No recent activity</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg border bg-card hover:border-primary/50 transition-colors">
      <div className="flex items-center gap-3 text-muted-foreground">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <span className="font-bold text-foreground">{value}</span>
    </div>
  );
}
