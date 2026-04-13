import { useState, useMemo, useRef, useEffect, useCallback } from "react";

// === ARRIVAL GENERATION ===

function generateArrivals(type, totalReaders, hoursSpan) {
  const hourlyCounts = new Array(hoursSpan).fill(0);

  if (type === "mailing-list") {
    for (let h = 0; h < hoursSpan; h++) {
      if (h < 1) hourlyCounts[h] = totalReaders * 0.22;
      else if (h < 3) hourlyCounts[h] = totalReaders * 0.13;
      else if (h < 6) hourlyCounts[h] = totalReaders * 0.06;
      else if (h < 12) hourlyCounts[h] = totalReaders * 0.02;
      else if (h < 24) hourlyCounts[h] = totalReaders * 0.004;
      else if (h < 48) hourlyCounts[h] = totalReaders * 0.002;
      else hourlyCounts[h] = totalReaders * 0.0003;
    }
  } else if (type === "search") {
    for (let h = 0; h < hoursSpan; h++) {
      const ramp = Math.min(h / (hoursSpan * 0.35), 1);
      const base = Math.pow(ramp, 0.6);
      const hod = h % 24;
      const awake = (hod >= 6 && hod < 18) ? 1.5 : 0.3;
      hourlyCounts[h] = base * awake * totalReaders * 0.005;
    }
  } else if (type === "link") {
    const spike = 8 + Math.floor(Math.random() * 28);
    for (let h = 0; h < hoursSpan; h++) {
      const dist = Math.abs(h - spike);
      const s = Math.exp(-dist * 0.16) * totalReaders * 0.14;
      const hod = h % 24;
      const awake = (hod >= 6 && hod < 18) ? 1.3 : 0.4;
      hourlyCounts[h] = s * awake;
    }
  } else if (type === "nostr") {
    const bursts = [
      5 + Math.floor(Math.random() * 18),
      28 + Math.floor(Math.random() * 36),
      75 + Math.floor(Math.random() * 50),
    ];
    for (let h = 0; h < hoursSpan; h++) {
      let v = totalReaders * 0.001;
      bursts.forEach(bh => {
        v += Math.exp(-Math.abs(h - bh) * 0.22) * totalReaders * 0.05;
      });
      const hod = h % 24;
      const awake = (hod >= 6 && hod < 18) ? 1.2 : 0.6;
      hourlyCounts[h] = v * awake;
    }
  } else if (type === "direct") {
    for (let h = 0; h < hoursSpan; h++) {
      const hod = h % 24;
      const awake = (hod >= 6 && hod < 18) ? 1.4 : 0.3;
      const decay = Math.exp(-h * 0.004);
      hourlyCounts[h] = decay * awake * totalReaders * 0.006;
    }
  }

  const rawSum = hourlyCounts.reduce((a, b) => a + b, 0);
  if (rawSum > 0) {
    const factor = totalReaders / rawSum;
    for (let i = 0; i < hourlyCounts.length; i++) hourlyCounts[i] *= factor;
  }

  const arrivals = [];
  for (let h = 0; h < hoursSpan; h++) {
    arrivals.push({ hour: h, hourOfDay: h % 24, count: hourlyCounts[h] });
  }
  return arrivals;
}

const HOURS_SPAN = 14 * 24;

const PUB_DATES = {
  "The Disappearing Coast": new Date(2026, 2, 28, 9, 0),
  "Salt and Stone": new Date(2026, 1, 14, 10, 0),
  "Against Efficiency": new Date(2026, 3, 8, 8, 0),
};

const SAMPLE_DATA = {
  title: "The Disappearing Coast",
  publishedAt: "28 March 2026",
  totalReaders: 1204,
  rank: "2nd this year",
  topSource: "Google search",
  topSourcePct: 38,
  conversions: 3,
  sources: [
    { id: 1, name: "Your mailing list", type: "mailing-list", readers: 412, isNew: false },
    { id: 2, name: "Google search", type: "search", readers: 458, isNew: false },
    { id: 3, name: "Littoral Drift", type: "link", readers: 142, domain: "littoraldrift.com", isNew: true },
    { id: 4, name: "theoverspill.com", type: "link", readers: 63, domain: "theoverspill.com", isNew: false },
    { id: 5, name: "@jmcee", type: "nostr", readers: 34, isNew: true },
    { id: 6, name: "Direct", type: "direct", readers: 58, isNew: false },
    { id: 7, name: "Hacker News", type: "link", readers: 22, domain: "news.ycombinator.com", isNew: true },
    { id: 8, name: "@alanreed", type: "nostr", readers: 8, isNew: false },
    { id: 9, name: "Bing", type: "search", readers: 7, isNew: false },
  ],
};

const SAMPLE_DATA_2 = {
  title: "Salt and Stone",
  publishedAt: "14 February 2026",
  totalReaders: 312,
  rank: "7th this year",
  topSource: "Your mailing list",
  topSourcePct: 71,
  conversions: 8,
  sources: [
    { id: 1, name: "Your mailing list", type: "mailing-list", readers: 221, isNew: false },
    { id: 2, name: "Google search", type: "search", readers: 42, isNew: false },
    { id: 3, name: "Direct", type: "direct", readers: 31, isNew: false },
    { id: 4, name: "@jmcee", type: "nostr", readers: 11, isNew: false },
    { id: 5, name: "reddit.com", type: "link", readers: 7, domain: "reddit.com", isNew: true },
  ],
};

const SAMPLE_DATA_3 = {
  title: "Against Efficiency",
  publishedAt: "8 April 2026",
  totalReaders: 89,
  rank: "—",
  topSource: "Your mailing list",
  topSourcePct: 82,
  conversions: 0,
  sources: [
    { id: 1, name: "Your mailing list", type: "mailing-list", readers: 73, isNew: false },
    { id: 2, name: "Direct", type: "direct", readers: 12, isNew: false },
    { id: 3, name: "Google search", type: "search", readers: 4, isNew: false },
  ],
};

function hydrateSources(data) {
  return {
    ...data,
    sources: data.sources.map(s => ({
      ...s,
      arrivals: generateArrivals(s.type, s.readers, HOURS_SPAN),
    })),
  };
}

// International Klein Blue
const IKB = "#002FA7";
const BG = "#FAFAFA";

// === OP ART BAR ===

function OpArtBar({ arrivals, width, height, pubDate, onHoverInfo }) {
  const canvasRef = useRef(null);

  // Build half-day blocks, newest first (left edge)
  const blocks = useMemo(() => {
    const result = [];
    let current = null;
    for (const a of arrivals) {
      const isDay = a.hourOfDay >= 6 && a.hourOfDay < 18;
      if (!current || current.isDay !== isDay) {
        if (current) result.push(current);
        current = { isDay, count: a.count, startHour: a.hour, endHour: a.hour };
      } else {
        current.count += a.count;
        current.endHour = a.hour;
      }
    }
    if (current) result.push(current);
    result.reverse();
    return result;
  }, [arrivals]);

  const totalCount = useMemo(() => blocks.reduce((s, b) => s + b.count, 0), [blocks]);

  // Precompute cumulative fractions for fast hover lookup
  const cumFracs = useMemo(() => {
    if (totalCount === 0) return [];
    let cum = 0;
    return blocks.map(b => {
      cum += b.count / totalCount;
      return cum;
    });
  }, [blocks, totalCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || totalCount === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    // Draw blocks
    let x = 0;
    for (const block of blocks) {
      const blockWidth = (block.count / totalCount) * width;
      if (block.isDay && blockWidth >= 0.4) {
        const x0 = Math.round(x);
        const x1 = Math.round(x + blockWidth);
        ctx.fillStyle = IKB;
        ctx.fillRect(x0, 0, Math.max(x1 - x0, 1), height);
      }
      x += blockWidth;
    }
  }, [blocks, totalCount, width, height]);

  const getInfoAtX = useCallback((clientX, rect) => {
    if (!pubDate || totalCount === 0 || blocks.length === 0) return null;
    const frac = (clientX - rect.left) / rect.width;

    // Binary search for the block
    let lo = 0, hi = cumFracs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumFracs[mid] < frac) lo = mid + 1;
      else hi = mid;
    }

    const block = blocks[lo];
    if (!block) return null;

    const d = new Date(pubDate.getTime() + block.startHour * 3600000);
    const dateStr = d.toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short",
    });
    const period = block.isDay ? "day" : "night";
    return `${dateStr} · ${period}`;
  }, [blocks, cumFracs, totalCount, pubDate]);

  const handleMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onHoverInfo(getInfoAtX(e.clientX, rect));
  }, [getInfoAtX, onHoverInfo]);

  const handleTouchMove = useCallback((e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onHoverInfo(getInfoAtX(touch.clientX, rect));
  }, [getInfoAtX, onHoverInfo]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: "block", cursor: "crosshair", touchAction: "none" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => onHoverInfo(null)}
      onTouchStart={handleTouchMove}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => onHoverInfo(null)}
    />
  );
}

function OpArtBarWrapper({ arrivals, totalReaders, height, pubDate, onHoverInfo }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const measure = () => { if (ref.current) setWidth(ref.current.offsetWidth); };
    measure();
    const obs = new ResizeObserver(measure);
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ width: "100%", height }}>
      {width > 0 && (
        <OpArtBar
          arrivals={arrivals}
          width={width}
          height={height}
          pubDate={pubDate}
          onHoverInfo={onHoverInfo}
        />
      )}
    </div>
  );
}

// === DIAGRAM ===

function ProvenanceDiagram({ data }) {
  const [selected, setSelected] = useState(null);
  const [hoverInfo, setHoverInfo] = useState(null);
  const maxReaders = Math.max(...data.sources.map(s => s.readers));
  const pubDate = PUB_DATES[data.title];

  const sorted = useMemo(
    () => [...data.sources].sort((a, b) => b.readers - a.readers),
    [data.sources]
  );

  return (
    <div style={{ fontFamily: "'Suisse Intl', 'Helvetica Neue', Helvetica, Arial, sans-serif" }}>
      {/* Summary */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        borderTop: "4px solid #1A1A1A", borderBottom: "4px solid #1A1A1A",
      }}>
        {[
          { label: "Readers", value: data.totalReaders.toLocaleString() },
          { label: "Rank", value: data.rank },
          { label: "Top source", value: `${data.topSource} (${data.topSourcePct}%)` },
          { label: "Conversions", value: `${data.conversions} paid` },
        ].map((item, i) => (
          <div key={i} style={{
            padding: "14px 10px",
            borderLeft: i > 0 ? "2px solid #1A1A1A" : "none",
          }}>
            <div style={{
              fontSize: 10, fontWeight: 600, textTransform: "uppercase",
              letterSpacing: "0.08em", color: "#888", marginBottom: 3,
            }}>{item.label}</div>
            <div style={{
              fontSize: 17, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.01em",
            }}>{item.value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24 }}>
        {/* Date readout */}
        <div style={{
          height: 18, marginBottom: 8,
          display: "flex", justifyContent: "flex-end", alignItems: "baseline",
        }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: IKB,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.01em",
            opacity: hoverInfo ? 1 : 0,
            transition: "opacity 0.06s",
          }}>
            {hoverInfo || ""}
          </div>
        </div>

        {/* Bars */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {sorted.map((source) => {
            const pct = (source.readers / maxReaders) * 100;
            const isSelected = selected === source.id;

            return (
              <div key={source.id}>
                <div
                  onClick={() => setSelected(isSelected ? null : source.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "128px 1fr 46px",
                    alignItems: "center",
                    cursor: "pointer",
                    padding: "4px 0",
                    borderBottom: "1px solid #EBEBEB",
                    backgroundColor: isSelected ? "#F0F0F0" : "transparent",
                    transition: "background-color 0.1s",
                  }}
                >
                  <div style={{
                    fontSize: 12, fontWeight: 600, color: "#1A1A1A",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    paddingRight: 8, display: "flex", alignItems: "center", gap: 5,
                  }}>
                    <span>{source.name}</span>
                    {source.isNew && (
                      <span style={{
                        fontSize: 8, fontWeight: 700, textTransform: "uppercase",
                        letterSpacing: "0.1em", color: IKB,
                        border: `1.5px solid ${IKB}`, padding: "1px 4px",
                        lineHeight: "1.3", flexShrink: 0,
                      }}>New</span>
                    )}
                  </div>

                  <div style={{ position: "relative", height: 24 }}>
                    <div style={{
                      position: "absolute", top: 0, left: 0, height: "100%",
                      width: `${Math.max(pct, 3)}%`, overflow: "hidden",
                    }}>
                      <OpArtBarWrapper
                        arrivals={source.arrivals}
                        totalReaders={source.readers}
                        height={24}
                        pubDate={pubDate}
                        onHoverInfo={setHoverInfo}
                      />
                    </div>
                  </div>

                  <div style={{
                    fontSize: 12, fontWeight: 700, color: "#1A1A1A",
                    textAlign: "right", fontVariantNumeric: "tabular-nums",
                  }}>
                    {source.readers.toLocaleString()}
                  </div>
                </div>

                {isSelected && (
                  <div style={{
                    backgroundColor: "#F0F0F0", padding: "10px 10px 10px 128px",
                    borderBottom: "1px solid #EBEBEB",
                  }}>
                    <div style={{ fontSize: 12, color: "#666", lineHeight: 1.7 }}>
                      {source.readers} of {data.totalReaders} total readers
                      ({Math.round((source.readers / data.totalReaders) * 100)}%).
                      {source.isNew && <><br />This source has not sent you readers before.</>}
                      {source.type === "mailing-list" && <><br />Subscribers who opened the email and clicked through.</>}
                      {source.type === "direct" && <><br />Typed the URL, used a bookmark, or a source that doesn't pass referrer data.</>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// === FEED ===

function FeedItem({ anchor, text }) {
  return (
    <div style={{
      padding: "13px 0", borderBottom: "1px solid #EBEBEB",
      fontFamily: "'Suisse Intl', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.06em", color: "#CCC", marginBottom: 4,
      }}>{anchor}</div>
      <div
        style={{ fontSize: 13.5, lineHeight: 1.55, color: "#1A1A1A" }}
        dangerouslySetInnerHTML={{ __html: text }}
      />
    </div>
  );
}

// === APP ===

export default function App() {
  const [active, setActive] = useState(0);
  const datasets = useMemo(
    () => [hydrateSources(SAMPLE_DATA), hydrateSources(SAMPLE_DATA_2), hydrateSources(SAMPLE_DATA_3)],
    []
  );
  const data = datasets[active];

  return (
    <div style={{
      maxWidth: 700, margin: "0 auto", padding: "20px 20px 40px",
      backgroundColor: BG, minHeight: "100vh",
      fontFamily: "'Suisse Intl', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "baseline", marginBottom: 4,
        }}>
          <div style={{
            fontSize: 12, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.14em", color: "#1A1A1A",
          }}>∀ all.haus</div>
          <div style={{
            fontSize: 10, fontWeight: 500, textTransform: "uppercase",
            letterSpacing: "0.08em", color: "#CCC",
          }}>Piece view</div>
        </div>
        <div style={{ width: "100%", height: 4, backgroundColor: "#1A1A1A" }} />
      </div>

      <div style={{ display: "flex", marginBottom: 24 }}>
        {datasets.map((d, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            style={{
              flex: 1, padding: "9px 4px", fontSize: 11,
              fontWeight: active === i ? 700 : 500,
              color: active === i ? BG : "#1A1A1A",
              backgroundColor: active === i ? "#1A1A1A" : "transparent",
              border: "2px solid #1A1A1A",
              borderRight: i < 2 ? "none" : "2px solid #1A1A1A",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >{d.title}</button>
        ))}
      </div>

      <h1 style={{
        fontSize: 26, fontWeight: 700, fontStyle: "italic", color: "#1A1A1A",
        margin: "0 0 2px", letterSpacing: "-0.02em", lineHeight: 1.15,
      }}>{data.title}</h1>
      <div style={{ fontSize: 12, color: "#AAA", marginBottom: 24 }}>
        Published {data.publishedAt}
      </div>

      <ProvenanceDiagram data={data} />

      <div style={{ marginTop: 36 }}>
        <div style={{ borderTop: "4px solid #1A1A1A", paddingTop: 10, marginBottom: 2 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.12em", color: "#1A1A1A",
          }}>Story of this piece</div>
        </div>

        {active === 0 && (
          <>
            <FeedItem anchor="Right now" text='3 people reading <em>The Disappearing Coast</em> right now.' />
            <FeedItem anchor="This morning" text='A new source appeared — a Ghost blog called <em>Littoral Drift</em> has sent 18 readers to <em>The Disappearing Coast</em> since this morning.' />
            <FeedItem anchor="Yesterday" text='Your mailing list opened <em>The Disappearing Coast</em> at 62%, which is higher than usual for you. Your usual open rate is around 45%.' />
            <FeedItem anchor="Yesterday" text='<em>The Disappearing Coast</em> had 340 readers on its first day. That&rsquo;s your third best opening this year.' />
            <FeedItem anchor="3 days ago" text='<em>The Disappearing Coast</em> has been reposted by 12 accounts on Nostr. 34 readers have arrived from these shares, most of them via @jmcee.' />
            <FeedItem anchor="5 days ago" text='<em>The Disappearing Coast</em> has now been read 1,000 times, which makes it your second most-read piece this year.' />
            <FeedItem anchor="Last week" text='The main source of readers for <em>The Disappearing Coast</em> has shifted from your mailing list to Google search. Google search now accounts for 38% of all readers.' />
          </>
        )}
        {active === 1 && (
          <>
            <FeedItem anchor="Today" text='No one reading right now. Your last reader was six hours ago.' />
            <FeedItem anchor="Yesterday" text='<em>Salt and Stone</em>, published 56 days ago, is getting traffic again — 7 readers yesterday, mostly from a link on reddit.com.' />
            <FeedItem anchor="This week" text='<em>Salt and Stone</em> has been the last free piece read before subscribing for 8 of your paying subscribers. No other piece has converted more.' />
            <FeedItem anchor="Last week" text='<em>Salt and Stone</em> is still drawing readers 56 days after publication — 18 readers in the last week. Most of your pieces go quiet after about a week.' />
          </>
        )}
        {active === 2 && (
          <>
            <FeedItem anchor="Right now" text='1 person reading <em>Against Efficiency</em> right now.' />
            <FeedItem anchor="Today" text='<em>Against Efficiency</em> had 89 readers on its first day. Your usual first-day readership is around 220.' />
            <FeedItem anchor="Today" text='First-day readers of <em>Against Efficiency</em> came from: your mailing list (82%), direct visits (13%), and other sources (5%).' />
          </>
        )}
      </div>

      <div style={{ marginTop: 40, height: 4, backgroundColor: "#1A1A1A" }} />
    </div>
  );
}
