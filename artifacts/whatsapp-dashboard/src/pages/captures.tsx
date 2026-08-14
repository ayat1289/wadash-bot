import { useState } from "react";
import {
  useListCaptures,
  useGetCaptureStats,
  useListCaptureSenders,
  useListCaptureChats,
  getListCapturesQueryKey,
  getGetCaptureStatsQueryKey,
} from "@workspace/api-client-react";
import type { Capture } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Trash2,
  Eye,
  Image as ImageIcon,
  Video,
  Mic,
  FileText,
  Sticker,
  Download,
  ShieldAlert,
} from "lucide-react";

type KindFilter = "all" | "deleted" | "viewonce";
type ChatTypeFilter = "all" | "dm" | "group";

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(c: Capture): string {
  const ts = Number(c.timestamp);
  const d = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(c.createdAt);
  return d.toLocaleString();
}

function ContentIcon({ type }: { type: Capture["contentType"] }) {
  switch (type) {
    case "image":
      return <ImageIcon size={16} />;
    case "video":
      return <Video size={16} />;
    case "audio":
      return <Mic size={16} />;
    case "sticker":
      return <Sticker size={16} />;
    case "document":
      return <FileText size={16} />;
    default:
      return <FileText size={16} />;
  }
}

function MediaPreview({ capture }: { capture: Capture }) {
  if (!capture.mediaUrl) return null;
  const mime = capture.mediaMimetype ?? "";
  const isImage = capture.contentType === "image" || mime.startsWith("image/");
  const isVideo = capture.contentType === "video" || mime.startsWith("video/");
  const isAudio = capture.contentType === "audio" || mime.startsWith("audio/");

  return (
    <div className="mt-2 space-y-2">
      {isImage && (
        <img
          src={capture.mediaUrl}
          alt="Captured media"
          className="max-h-72 rounded-md border object-contain"
          data-testid={`media-image-${capture.id}`}
        />
      )}
      {isVideo && (
        <video
          src={capture.mediaUrl}
          controls
          className="max-h-72 rounded-md border"
          data-testid={`media-video-${capture.id}`}
        />
      )}
      {isAudio && (
        <audio
          src={capture.mediaUrl}
          controls
          className="w-full"
          data-testid={`media-audio-${capture.id}`}
        />
      )}
      <a href={capture.mediaUrl} download target="_blank" rel="noreferrer">
        <Button variant="outline" size="sm" data-testid={`download-${capture.id}`}>
          <Download size={14} className="mr-1.5" />
          Download{capture.mediaSize ? ` (${formatBytes(capture.mediaSize)})` : ""}
        </Button>
      </a>
    </div>
  );
}

function StatCard({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        {loading ? (
          <Skeleton className="h-7 w-12 mt-1" />
        ) : (
          <div className="text-2xl font-bold mt-0.5">{value ?? 0}</div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Captures() {
  const [kind, setKind] = useState<KindFilter>("all");
  const [chatType, setChatType] = useState<ChatTypeFilter>("all");
  const [senderJid, setSenderJid] = useState<string>("all");
  const [chatJid, setChatJid] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const params = {
    ...(kind !== "all" ? { kind } : {}),
    ...(chatType !== "all" ? { chatType } : {}),
    ...(senderJid !== "all" ? { senderJid } : {}),
    ...(chatJid !== "all" ? { chatJid } : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}),
    limit: 200,
  };

  const { data: captures, isLoading } = useListCaptures(params, {
    query: { queryKey: getListCapturesQueryKey(params), refetchInterval: 15000 },
  });

  const { data: stats, isLoading: statsLoading } = useGetCaptureStats({
    query: { queryKey: getGetCaptureStatsQueryKey(), refetchInterval: 15000 },
  });

  const { data: senders } = useListCaptureSenders();
  const { data: chats } = useListCaptureChats();

  const hasFilters =
    kind !== "all" ||
    chatType !== "all" ||
    senderJid !== "all" ||
    chatJid !== "all" ||
    from !== "" ||
    to !== "";

  const clearFilters = () => {
    setKind("all");
    setChatType("all");
    setSenderJid("all");
    setChatJid("all");
    setFrom("");
    setTo("");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ShieldAlert size={24} className="text-primary" />
          Captured Messages
        </h1>
        <p className="text-muted-foreground mt-1">
          Deleted messages and revealed view-once media, recorded for later review.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total" value={stats?.total} loading={statsLoading} />
        <StatCard label="Deleted" value={stats?.deleted} loading={statsLoading} />
        <StatCard label="View-once" value={stats?.viewonce} loading={statsLoading} />
        <StatCard label="With media" value={stats?.withMedia} loading={statsLoading} />
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Type</label>
            <Select value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
              <SelectTrigger className="w-36" data-testid="filter-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="deleted">Deleted</SelectItem>
                <SelectItem value="viewonce">View-once</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Chat</label>
            <Select value={chatType} onValueChange={(v) => setChatType(v as ChatTypeFilter)}>
              <SelectTrigger className="w-32" data-testid="filter-chattype">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All chats</SelectItem>
                <SelectItem value="dm">Direct</SelectItem>
                <SelectItem value="group">Groups</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Sender</label>
            <Select value={senderJid} onValueChange={setSenderJid}>
              <SelectTrigger className="w-44" data-testid="filter-sender">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All senders</SelectItem>
                {senders?.map((s) => (
                  <SelectItem key={s.senderJid} value={s.senderJid}>
                    {s.senderName || s.senderJid} ({s.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Group / Chat</label>
            <Select value={chatJid} onValueChange={setChatJid}>
              <SelectTrigger className="w-44" data-testid="filter-chat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All groups / chats</SelectItem>
                {chats?.map((c) => (
                  <SelectItem key={c.chatJid} value={c.chatJid}>
                    {c.chatName || c.chatJid} ({c.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">From</label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
              data-testid="filter-from"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">To</label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
              data-testid="filter-to"
            />
          </div>

          {hasFilters && (
            <Button variant="ghost" onClick={clearFilters} data-testid="clear-filters">
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : !captures || captures.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No captures yet. Deleted and view-once messages will appear here once the bot sees them.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {captures.map((c) => (
            <Card key={c.id} data-testid={`capture-${c.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    {c.kind === "deleted" ? (
                      <Badge variant="destructive" className="gap-1">
                        <Trash2 size={12} /> Deleted
                      </Badge>
                    ) : (
                      <Badge className="gap-1 bg-amber-500 hover:bg-amber-500">
                        <Eye size={12} /> View-once
                      </Badge>
                    )}
                    <Badge variant="outline" className="gap-1">
                      <ContentIcon type={c.contentType} />
                      {c.contentType}
                    </Badge>
                    {c.chatType === "group" && (
                      <Badge variant="secondary">{c.chatName || "Group"}</Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{formatWhen(c)}</span>
                </div>

                <div className="mt-2 text-sm">
                  <span className="font-medium">{c.senderName || c.senderJid}</span>
                  {c.senderName && (
                    <span className="text-muted-foreground"> · {c.senderJid}</span>
                  )}
                </div>

                {c.body && <p className="mt-1 text-sm whitespace-pre-wrap break-words">{c.body}</p>}

                {c.kind === "deleted" && !c.body && !c.mediaUrl && (
                  <p className="mt-1 text-sm text-muted-foreground italic">
                    Media could not be recovered (it may have been purged before the bot saw the
                    deletion).
                  </p>
                )}

                <MediaPreview capture={c} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
