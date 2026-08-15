export const clock = (s: number) => {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};

export const showTime = (t: number) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
};

export const parseTime = (s: string): number => {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec((s ?? "").trim());
  if (!m) return NaN;
  return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
};

export const fmtSize = (n: number) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;

export const fmtDate = (ts: number) => {
  const d = new Date((ts || 0) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const fmtViews = (n: number | null) =>
  !n ? "" : n >= 1e8 ? `${(n / 1e8).toFixed(1)}억회` : n >= 1e4 ? `${Math.round(n / 1e4)}만회` : `${n}회`;
