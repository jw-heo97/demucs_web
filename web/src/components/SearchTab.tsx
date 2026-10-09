import { useState } from "react";
import { api } from "../api";
import { clock, fmtViews } from "../lib/time";
import type { SearchItem } from "../types";

const VID = "[0-9A-Za-z_-]{11}";
const PATTERNS = [
  new RegExp(`youtube\\.com/watch\\?(?:[^#]*&)?v=(${VID})`),
  new RegExp(`youtu\\.be/(${VID})`),
  new RegExp(`youtube\\.com/(?:embed|shorts|live|v)/(${VID})`),
  new RegExp(`^(${VID})$`),
];
const videoId = (s: string) => {
  const t = (s || "").trim();
  for (const p of PATTERNS) {
    const m = p.exec(t);
    if (m) return m[1];
  }
  return null;
};

export function SearchTab({ onPick }: { onPick: (videoId: string, title: string) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  const run = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setErr("");
    try {
      const direct = videoId(query);
      if (direct) {
        const d = await api.resolve(direct);
        setItems([
          {
            video_id: d.video_id,
            title: d.title,
            channel: d.channel,
            duration: d.duration,
            view_count: null,
            live: d.live ?? false,
            thumbnail: d.thumbnail,
          },
        ]);
        setPreview(d.video_id);
      } else {
        const d = await api.search(query, 12);
        setItems(d.items);
      }
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="panel">
        <label htmlFor="q">검색어</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="q"
            style={{ flex: 1 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="곡 제목, 아티스트, 또는 YouTube 주소"
          />
          <button onClick={run} disabled={busy}>검색</button>
        </div>
        <div className="meta" style={{ marginTop: 6 }}>
          결과의 <b>선택</b>을 누르면 주소와 제목이 [분리 작업] 탭에 자동으로 채워집니다.
        </div>
        {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {preview && (
        <div className="panel">
          <label>미리보기</label>
          <div style={{ aspectRatio: "16/9", maxWidth: 860, background: "#000", borderRadius: 9, overflow: "hidden" }}>
            <iframe
              style={{ width: "100%", height: "100%", border: 0 }}
              src={`https://www.youtube.com/embed/${preview}?rel=0&playsinline=1`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
          <div className="meta" style={{ marginTop: 6 }}>
            재생이 안 되면 소유자가 외부 재생을 막은 것입니다. 분리 작업에는 영향이 없습니다.
          </div>
        </div>
      )}

      <div className="results">
        {items.map((v) => (
          <div className="card" key={v.video_id}>
            <div className="thumb" onClick={() => setPreview(v.video_id)} style={{ cursor: "pointer" }}>
              <img src={v.thumbnail} alt="" loading="lazy" />
              {v.live ? (
                <span className="dur live">LIVE</span>
              ) : (
                !!v.duration && <span className="dur">{clock(v.duration)}</span>
              )}
            </div>
            <div className="body">
              <div className="t">{v.title}</div>
              <div className="meta">
                {v.channel}
                {v.view_count ? ` · ${fmtViews(v.view_count)}` : ""}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 6 }}>
                {/* 라이브는 서버가 거절하므로 (다운로드가 끝나지 않는다) 여기서부터 막는다 */}
                <button
                  style={{ flex: 1, padding: "6px 0", fontSize: ".78rem" }}
                  disabled={v.live}
                  title={v.live ? "라이브 방송은 분리할 수 없습니다" : undefined}
                  onClick={() => onPick(v.video_id, v.title)}
                >
                  선택
                </button>
                <button className="ghost" style={{ flex: 1 }} onClick={() => setPreview(v.video_id)}>
                  미리보기
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
