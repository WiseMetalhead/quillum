import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { API_BASE, apiRequest } from "../../api/client";
import { Icon, type IconName } from "../../icons/Icon";
import type {
  NotificationItem,
  NotificationKind,
  NotificationPage,
} from "../../types";
import { TadpoleLoadingState } from "../shared/TadpoleLoadingState";
import { useMobileViewport } from "../shared/useMobileViewport";
import { groupNotificationItems } from "./notificationGroups";
import { SafeNotificationMarkdown } from "./SafeNotificationMarkdown";
import "./NotificationPanel.css";

type Props = {
  disabled: boolean;
  onNavigate: (path: string, kind: NotificationKind) => void;
  onError: (message: string) => void;
};

type Filter = "all" | "unread";

const icons: Record<NotificationKind, IconName> = {
  "service.password_stale": "password-light",
  "service.two_factor_missing": "shield-minimalistic-light",
  "service.review_share_expired": "share-light",
  "service.export_expiring": "download-minimalistic-light",
  "service.storage_near_limit": "ssd-round-light",
  "service.tier_changed": "crown-minimalistic-light",
  "service.new_login": "user-check-rounded-light",
  "service.account_export_ready": "archive-light",
  "service.audio_transcription_ready": "soundwave-linear",
  "service.audio_transcription_failed": "soundwave-linear",
  "service.editor_manuscript_access_granted": "share-light",
  "service.editor_manuscript_access_revoked": "share-light",
  "admin.announcement": "bell-light",
  "user.manuscript_deadline": "calendar-light",
  "user.item_deadline": "calendar-minimalistic-light",
  "user.task_deadline": "checklist-minimalistic-light",
  "user.review_comment": "dialog-2-light",
  "user.daily_goal": "trend-up-light",
  "user.manuscript_digest": "clipboard-list-light",
};

const manuscriptExportDownloadPath = /^\/api\/manuscripts\/exports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/download\/$/i;
const accountExportDownloadPath = /^\/api\/auth\/account\/export\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/download\/$/i;

function websocketUrl() {
  const base = import.meta.env.DEV ? window.location.origin : API_BASE || window.location.origin;
  const url = new URL("/ws/notifications/", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
      typeof item === "object" && item !== null
    ))
    : [];
}

function notificationTime(value: string, language: string) {
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

type NotificationBodyProps = {
  id: string;
  body: string;
  markdown: boolean;
  expanded: boolean;
  onOverflowChange: (id: string, overflowing: boolean) => void;
};

function NotificationBody({
  id,
  body,
  markdown,
  expanded,
  onOverflowChange,
}: NotificationBodyProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element || expanded) return;
    const measure = () => {
      onOverflowChange(id, element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body, expanded, id, onOverflowChange]);

  return (
    <div
      ref={bodyRef}
      className={`notificationBody ${expanded ? "expanded" : "collapsed"}`}
    >
      {markdown ? (
        <SafeNotificationMarkdown source={body} />
      ) : (
        <span>{body}</span>
      )}
    </div>
  );
}

export function NotificationPanel({ disabled, onNavigate, onError }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [socketConnected, setSocketConnected] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandable, setExpandable] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const isMobile = useMobileViewport();
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const listEntries = useMemo(() => groupNotificationItems(items), [items]);

  const updateOverflow = useCallback((id: string, overflowing: boolean) => {
    setExpandable((current) => {
      if (current.has(id) === overflowing) return current;
      const next = new Set(current);
      if (overflowing) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const loadSummary = useCallback(async () => {
    const payload = await apiRequest<{ unreadCount: number }>(
      "/api/notifications/summary/",
    );
    setUnreadCount(payload.unreadCount);
  }, []);

  const loadItems = useCallback(async (selectedFilter: Filter, cursor = "") => {
    const query = new URLSearchParams({ filter: selectedFilter });
    if (cursor) query.set("cursor", cursor);
    const payload = await apiRequest<NotificationPage>(
      `/api/notifications/?${query}`,
    );
    setItems((current) =>
      cursor ? [...current, ...payload.items] : payload.items,
    );
    setNextCursor(payload.nextCursor);
    setUnreadCount(payload.unreadCount);
  }, []);

  const reportRequestError = useCallback((error: unknown, fallback: string) => {
    if (!navigator.onLine) return;
    onError(error instanceof Error ? error.message : fallback);
  }, [onError]);

  const refresh = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      await loadSummary();
      if (open) await loadItems(filter);
    } catch (error) {
      reportRequestError(error, t("notifications.loadFailed"));
    }
  }, [filter, loadItems, loadSummary, open, reportRequestError, t]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (disabled || !online) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [disabled, online, refresh]);

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }
    function handleOffline() {
      setOnline(false);
      setSocketConnected(false);
      setOpen(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (disabled || !online) return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let attempt = 0;
    let active = true;
    function connect() {
      if (!active || !navigator.onLine) return;
      socket = new WebSocket(websocketUrl());
      socket.addEventListener("open", () => {
        attempt = 0;
        setSocketConnected(true);
      });
      socket.addEventListener("message", () => {
        void refreshRef.current();
      });
      socket.addEventListener("close", () => {
        if (!active || !navigator.onLine) return;
        setSocketConnected(false);
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        retry = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket?.close());
    }
    retry = window.setTimeout(connect, 0);
    return () => {
      active = false;
      if (retry) window.clearTimeout(retry);
      socket?.close();
    };
  }, [disabled, online]);

  useEffect(() => {
    if (socketConnected || disabled || !online) return;
    const timer = window.setInterval(() => void refreshRef.current(), 60_000);
    return () => window.clearInterval(timer);
  }, [disabled, online, socketConnected]);

  useEffect(() => {
    function focus() {
      if (!disabled && navigator.onLine) void refreshRef.current();
    }
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const focusable = popoverRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), select, [tabindex="0"]',
    );
    focusable?.focus();
    function close(event: MouseEvent) {
      if (
        !rootRef.current?.contains(event.target as Node) &&
        !popoverRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !popoverRef.current) return;
      const controls = [
        ...popoverRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select, [tabindex="0"]',
        ),
      ];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  async function selectFilter(next: Filter) {
    setFilter(next);
    setLoading(true);
    try {
      await loadItems(next);
    } catch (error) {
      reportRequestError(error, t("notifications.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function markAllRead() {
    try {
      await apiRequest("/api/notifications/read-all/", {
        method: "POST",
        body: "{}",
      });
      setUnreadCount(0);
      setItems((current) =>
        filter === "unread"
          ? []
          : current.map((item) => ({
              ...item,
              readAt: item.readAt ?? new Date().toISOString(),
            })),
      );
    } catch (error) {
      reportRequestError(error, t("notifications.readFailed"));
    }
  }

  async function activate(item: NotificationItem) {
    try {
      if (!item.readAt)
        await apiRequest(`/api/notifications/${item.id}/read/`, {
          method: "PATCH",
          body: "{}",
        });
      const exportId = stringValue(item.payload.exportId);
      const storedDownloadPath = stringValue(item.payload.downloadPath);
      const downloadPath = storedDownloadPath || (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exportId)
          ? `/api/manuscripts/exports/${exportId}/download/`
          : ""
      );
      if (
        (item.kind === "service.export_expiring" && manuscriptExportDownloadPath.test(downloadPath)) ||
        (item.kind === "service.account_export_ready" && accountExportDownloadPath.test(downloadPath))
      ) {
        setOpen(false);
        const link = document.createElement("a");
        link.href = `${API_BASE}${downloadPath}`;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        return;
      }
      const path = stringValue(item.payload.actionPath);
      if (item.kind !== "service.new_login" && path.startsWith("/")) {
        setOpen(false);
        onNavigate(path, item.kind);
      } else await refresh();
    } catch (error) {
      reportRequestError(error, t("notifications.readFailed"));
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await loadItems(filter, nextCursor);
    } catch (error) {
      reportRequestError(error, t("notifications.loadFailed"));
    } finally {
      setLoadingMore(false);
    }
  }

  function copy(item: NotificationItem) {
    const values = item.payload;
    if (item.kind === "admin.announcement") {
      return { title: stringValue(values.title), body: stringValue(values.body) };
    }
    if (item.kind === "user.daily_goal") {
      const number = new Intl.NumberFormat(i18n.language);
      return {
        title: t("notifications.kinds.user_daily_goal.title", values),
        body: t(
          values.completed
            ? "notifications.kinds.user_daily_goal.bodyCompleted"
            : "notifications.kinds.user_daily_goal.bodyPending",
          {
            ...values,
            writtenWords: number.format(numberValue(values.writtenWords)),
            goalWords: number.format(numberValue(values.goalWords)),
          },
        ),
      };
    }
    if (item.kind === "user.manuscript_digest") {
      const number = new Intl.NumberFormat(i18n.language);
      const date = (value: unknown) => {
        const parsed = stringValue(value);
        return parsed
          ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" })
            .format(new Date(`${parsed}T12:00:00`))
          : "";
      };
      const lines = [
        t("notifications.kinds.user_manuscript_digest.progress", {
          total: number.format(numberValue(values.totalWords)),
          goal: number.format(numberValue(values.wordGoal)),
        }),
      ];
      const statuses = objectList(values.statusBreakdown);
      if (statuses.length) {
        lines.push(t("notifications.kinds.user_manuscript_digest.statuses"));
        lines.push(...statuses.map((status) => t(
          "notifications.kinds.user_manuscript_digest.statusLine",
          {
            name: stringValue(status.name) || t("notifications.noStatus"),
            count: numberValue(status.count),
          },
        )));
      }
      const deadlines = objectList(values.deadlines);
      if (deadlines.length) {
        lines.push(t("notifications.kinds.user_manuscript_digest.deadlines"));
        lines.push(...deadlines.map((deadline) => `• ${stringValue(deadline.title)} — ${date(deadline.date)}`));
        const remaining = numberValue(values.remainingDeadlines);
        if (remaining) lines.push(t("notifications.moreItems", { count: remaining }));
      }
      const tasks = objectList(values.tasks);
      if (tasks.length) {
        lines.push(t("notifications.kinds.user_manuscript_digest.tasks"));
        lines.push(...tasks.map((task) => `• ${stringValue(task.title)} — ${date(task.date)}`));
        const remaining = numberValue(values.remainingTasks);
        if (remaining) lines.push(t("notifications.moreItems", { count: remaining }));
      }
      return {
        title: t("notifications.kinds.user_manuscript_digest.title", values),
        body: lines.join("\n"),
      };
    }
    const key = item.kind.replaceAll(".", "_");
    const method = stringValue(values.method);
    const previousTier = stringValue(values.previousTier);
    const nextTier = stringValue(values.nextTier);
    return {
      title: t(`notifications.kinds.${key}.title`, values),
      body: t(`notifications.kinds.${key}.body`, {
        ...values,
        count: numberValue(values.daysRemaining),
        method: method ? t(`notifications.methods.${method}`) : "",
        previousTier: previousTier ? t(`tiers.names.${previousTier}`) : "",
        nextTier: nextTier ? t(`tiers.names.${nextTier}`) : "",
        guestName: stringValue(values.guestName) || t("notifications.guest"),
        used: new Intl.NumberFormat(i18n.language, {
          style: "unit",
          unit: "megabyte",
          maximumFractionDigits: 0,
        }).format(numberValue(values.usedBytes) / 1024 / 1024),
        limit: new Intl.NumberFormat(i18n.language, {
          style: "unit",
          unit: "megabyte",
          maximumFractionDigits: 0,
        }).format(numberValue(values.limitBytes) / 1024 / 1024),
      }),
    };
  }

  function notificationCard(item: NotificationItem, grouped = false) {
    const text = copy(item);
    const isExpanded = expanded.has(item.id);
    return (
      <article
        key={item.id}
        className={`${item.readAt ? "read" : "unread"}${grouped ? " notificationGroupItem" : ""}`}
      >
        <div
          role="button"
          tabIndex={0}
          className="notificationItemMain spaceButton"
          onClick={() => void activate(item)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void activate(item);
            }
          }}
        >
          <span
            className="notificationUnreadDot"
            aria-hidden="true"
          />
          <Icon
            name={icons[item.kind]}
            className="notificationKindIcon"
          />
          <span className="notificationCopy">
            <strong>{text.title}</strong>
            <NotificationBody
              id={item.id}
              body={text.body}
              markdown={item.kind === "admin.announcement"}
              expanded={isExpanded}
              onOverflowChange={updateOverflow}
            />
            <time dateTime={item.createdAt}>
              {notificationTime(item.createdAt, i18n.language)}
            </time>
          </span>
        </div>
        {expandable.has(item.id) && (
          <button
            type="button"
            className="notificationExpand spaceButton"
            onClick={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id);
                else next.add(item.id);
                return next;
              })
            }
          >
            {t(
              isExpanded
                ? "notifications.showLess"
                : "notifications.showMore",
            )}
          </button>
        )}
      </article>
    );
  }

  function notificationGroup(groupItems: NotificationItem[]) {
    const representative = groupItems[0];
    const text = copy(representative);
    const isExpanded = groupItems.some((item) => expandedGroups.has(item.id));
    const groupId = `notification-group-${representative.id}`;
    return (
      <section
        key={representative.id}
        className={`notificationGroup${isExpanded ? " expanded" : ""}`}
      >
        <button
          type="button"
          className="notificationGroupHeader spaceButton"
          aria-expanded={isExpanded}
          aria-controls={groupId}
          aria-label={t(
            isExpanded
              ? "notifications.collapseGroup"
              : "notifications.expandGroup",
            { title: text.title },
          )}
          onClick={() => {
            setExpandedGroups((current) => {
              const next = new Set(current);
              for (const item of groupItems) {
                if (isExpanded) next.delete(item.id);
                else next.add(item.id);
              }
              return next;
            });
          }}
        >
          <span className="notificationUnreadDot" aria-hidden="true" />
          <Icon
            name={icons[representative.kind]}
            className="notificationKindIcon"
          />
          <span className="notificationCopy">
            <strong>{text.title}</strong>
            <span className="notificationGroupCount">
              {t("notifications.groupCount", { count: groupItems.length })}
            </span>
            <time dateTime={representative.createdAt}>
              {notificationTime(representative.createdAt, i18n.language)}
            </time>
          </span>
          <Icon
            name={isExpanded ? "arrow-up-2" : "arrow-down-2"}
            className="notificationGroupToggle"
          />
        </button>
        {isExpanded && (
          <div id={groupId} className="notificationGroupItems">
            {groupItems.map((item) => notificationCard(item, true))}
          </div>
        )}
      </section>
    );
  }

  const notificationPanel = (
    <section
      ref={popoverRef}
      id="notification-popover"
      className={`notificationPopover${open ? " open" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-label={t("notifications.title")}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <header>
        <div>
          <h2>{t("notifications.title")}</h2>
          {unreadCount > 0 && (
            <span>{unreadCount > 99 ? "99+" : unreadCount}</span>
          )}
        </div>
        <button
          type="button"
          className="spaceButton"
          disabled={unreadCount === 0}
          onClick={() => void markAllRead()}
        >
          {t("notifications.markAllRead")} <Icon name="check-read-light" />
        </button>
      </header>
      <div className="notificationTabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={filter === "all"}
          className={`spaceButton ${filter === "all" ? "active" : ""}`}
          onClick={() => void selectFilter("all")}
        >
          {t("notifications.all")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === "unread"}
          className={`spaceButton ${filter === "unread" ? "active" : ""}`}
          onClick={() => void selectFilter("unread")}
        >
          {t("notifications.unread")}
        </button>
      </div>
      <div className="notificationList" aria-busy={loading}>
        {loading && (
          <TadpoleLoadingState
            className="notificationLoadingState"
            label={t("notifications.loading")}
          />
        )}
        {!loading && items.length === 0 && (
          filter === "unread" ? (
            <p className="notificationState notificationUnreadEmpty">
              <Icon name="like-light" />
              <span>{t("notifications.noUnread")}</span>
            </p>
          ) : (
            <p className="notificationState">{t("notifications.empty")}</p>
          )
        )}
        {!loading && listEntries.map((entry) => (
          entry.type === "group"
            ? notificationGroup(entry.items)
            : notificationCard(entry.item)
        ))}
        {nextCursor && (
          <button
            type="button"
            className="notificationLoadMore spaceButton"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {t(
              loadingMore
                ? "notifications.loading"
                : "notifications.loadMore",
            )}
          </button>
        )}
      </div>
    </section>
  );

  return (
    <div className="notificationMenu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="notificationButton spaceButton"
        aria-label={t("notifications.open")}
        title={t("notifications.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notification-popover"
        disabled={disabled || !online}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void selectFilter(filter);
        }}
      >
        <Icon name="bell-light" />
        {unreadCount > 0 && (
          <span className="notificationBadge">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {isMobile ? createPortal(notificationPanel, document.body) : notificationPanel}
    </div>
  );
}
