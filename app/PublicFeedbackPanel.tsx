"use client";

import { useMemo, useState } from "react";

import styles from "./public-feedback.module.css";
import {
  submitPublicFeedback,
  type PublicFeedbackReasonCode,
} from "./public-data/feedback-client.ts";

const reasons: Array<{ value: PublicFeedbackReasonCode; label: string }> = [
  { value: "OUTDATED", label: "Nội dung đã cũ" },
  { value: "WRONG_BUILD", label: "Lối chơi chưa đúng" },
  { value: "WRONG_ITEMS", label: "Trang bị chưa đúng" },
  { value: "WRONG_AUGMENTS", label: "Lõi chưa đúng" },
  { value: "MISMATCHED_CHAMPION", label: "Không khớp tướng" },
  { value: "OTHER", label: "Lỗi khác" },
];

type FeedbackStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "accepted" }
  | { kind: "invalid" }
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "unavailable" };

export function PublicFeedbackPanel({
  publicationId,
  publicationVersionId,
}: {
  publicationId: string;
  publicationVersionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<PublicFeedbackReasonCode>("WRONG_ITEMS");
  const [details, setDetails] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [status, setStatus] = useState<FeedbackStatus>({ kind: "idle" });

  const normalizedDetails = details.trim();
  const canSubmit = useMemo(
    () => status.kind !== "sending" && (reasonCode !== "OTHER" || normalizedDetails.length > 0),
    [normalizedDetails.length, reasonCode, status.kind],
  );

  function invalidateAttempt() {
    setSubmissionId(null);
    setStatus({ kind: "idle" });
  }

  function resetForm() {
    setReasonCode("WRONG_ITEMS");
    setDetails("");
    setSubmissionId(null);
  }

  async function submit() {
    if (!canSubmit) return;
    const currentSubmissionId = submissionId ?? crypto.randomUUID();
    if (!submissionId) setSubmissionId(currentSubmissionId);
    setStatus({ kind: "sending" });

    const result = await submitPublicFeedback({
      publicationId,
      publicationVersionId,
      submissionId: currentSubmissionId,
      reasonCode,
      ...(normalizedDetails ? { details: normalizedDetails } : {}),
    });

    if (result.outcome === "accepted") {
      setStatus({ kind: "accepted" });
      resetForm();
      return;
    }
    if (result.outcome === "rate_limited") {
      setStatus({
        kind: "rate_limited",
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
      });
      return;
    }
    if (result.outcome === "invalid") {
      setStatus({ kind: "invalid" });
      setSubmissionId(null);
      return;
    }
    setStatus({ kind: "unavailable" });
  }

  if (!open) {
    return (
      <button
        className={styles.trigger}
        type="button"
        onClick={() => {
          setOpen(true);
          setStatus({ kind: "idle" });
        }}
      >
        Báo lỗi nội dung
      </button>
    );
  }

  return (
    <section className={styles.panel} aria-label="Báo lỗi nội dung">
      <div className={styles.heading}>
        <div>
          <strong>Báo lỗi nội dung</strong>
          <small>Phản hồi chỉ là tín hiệu cộng đồng và sẽ được kiểm tra trước khi có thay đổi.</small>
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label="Đóng báo lỗi"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>

      <label className={styles.field}>
        <span>Loại lỗi</span>
        <select
          value={reasonCode}
          onChange={(event) => {
            setReasonCode(event.target.value as PublicFeedbackReasonCode);
            invalidateAttempt();
          }}
        >
          {reasons.map((reason) => (
            <option key={reason.value} value={reason.value}>{reason.label}</option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span>Mô tả ngắn {reasonCode === "OTHER" ? "(bắt buộc)" : "(không bắt buộc)"}</span>
        <textarea
          value={details}
          maxLength={280}
          rows={3}
          placeholder="Ví dụ: món thứ ba không còn phù hợp ở bản hiện tại"
          onChange={(event) => {
            setDetails(event.target.value);
            invalidateAttempt();
          }}
        />
        <small>{details.length}/280</small>
      </label>

      {status.kind === "accepted" && (
        <p className={`${styles.status} ${styles.success}`} role="status">Đã ghi nhận phản hồi. Cảm ơn bạn.</p>
      )}
      {status.kind === "invalid" && (
        <p className={`${styles.status} ${styles.error}`} role="status">Phản hồi không còn hợp lệ. Vui lòng kiểm tra lại nội dung.</p>
      )}
      {status.kind === "rate_limited" && (
        <p className={`${styles.status} ${styles.error}`} role="status">
          Bạn đã gửi nhiều phản hồi gần đây. Vui lòng thử lại sau
          {status.retryAfterSeconds ? ` khoảng ${status.retryAfterSeconds} giây` : ""}.
        </p>
      )}
      {status.kind === "unavailable" && (
        <p className={`${styles.status} ${styles.error}`} role="status">Kênh phản hồi đang tạm thời không khả dụng. Bạn có thể thử lại mà không mất nội dung.</p>
      )}

      <div className={styles.actions}>
        <button type="button" onClick={() => setOpen(false)}>Hủy</button>
        <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
          {status.kind === "sending" ? "Đang gửi…" : status.kind === "unavailable" ? "Thử lại" : "Gửi phản hồi"}
        </button>
      </div>
    </section>
  );
}
