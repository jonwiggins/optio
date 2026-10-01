import { ANSWERS } from "./answers";

/**
 * The article's diagram: the five answers flow into one model of work, the
 * Optio API serves it, and every client reads the same rows. From `sm` up it
 * is one wide SVG; on phones, where that SVG's text would shrink to a few
 * pixels, the same picture is stacked top to bottom in HTML. The dashed lines
 * move (CSS, `.flow`), and hold still with reduced motion.
 */

const CLIENTS = ["Web", "iOS", "Android", "CLI"];
const WORK_LINES = ["one trigger dispatcher", "one environment builder"];
/** The secondary text in both versions (a touch brighter than text-muted, for small sizes). */
const DETAIL = "#a9a5b1";
const LABEL =
  "When, Where, Who, Environment, and Then flow into one model of work; the Optio API serves it to the web, iOS, Android, and CLI clients.";

const W = 960;
const H = 360;
const ROW = 66;
const TOP = 22;

function WideDiagram() {
  const work = { x: 380, y: 125, w: 200, h: 110 };
  const api = { x: 630, y: 155, w: 140, h: 50 };
  const cy = work.y + work.h / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={LABEL}>
      {ANSWERS.map((a, i) => {
        const y = TOP + i * ROW;
        const sy = y + 22;
        return (
          <g key={a.key}>
            <path
              className="flow"
              d={`M 250 ${sy} C 330 ${sy}, 320 ${cy}, ${work.x} ${cy}`}
              fill="none"
              stroke={a.color}
              strokeOpacity={0.7}
              strokeWidth={1.6}
              style={{ animationDelay: `${i * 0.25}s` }}
            />
            <rect
              x={10}
              y={y}
              width={240}
              height={44}
              rx={10}
              fill={`${a.color}18`}
              stroke={`${a.color}88`}
            />
            <text x={24} y={y + 19} fill={a.color} fontSize={13} fontWeight={700}>
              {a.name}
            </text>
            <text x={24} y={y + 35} fill={DETAIL} fontSize={11}>
              {a.detail}
            </text>
          </g>
        );
      })}

      <rect
        x={work.x}
        y={work.y}
        width={work.w}
        height={work.h}
        rx={16}
        fill="#6d28d933"
        stroke="#a78bfa"
        strokeWidth={1.5}
      />
      <text
        x={work.x + work.w / 2}
        y={cy - 10}
        textAnchor="middle"
        fill="#f4f2ed"
        fontSize={22}
        fontWeight={700}
      >
        Work
      </text>
      {WORK_LINES.map((line, i) => (
        <text
          key={line}
          x={work.x + work.w / 2}
          y={cy + 20 + i * 15}
          textAnchor="middle"
          fill={DETAIL}
          fontSize={11}
        >
          {line}
        </text>
      ))}

      <path
        className="flow"
        d={`M ${work.x + work.w} ${cy} L ${api.x} ${cy}`}
        stroke="#a78bfa"
        strokeWidth={1.6}
        fill="none"
      />
      <rect
        x={api.x}
        y={api.y}
        width={api.w}
        height={api.h}
        rx={10}
        fill="#1f1f27"
        stroke="#3c3c48"
      />
      <text
        x={api.x + api.w / 2}
        y={api.y + 30}
        textAnchor="middle"
        fill="#e8e5df"
        fontSize={14}
        fontWeight={600}
      >
        Optio API
      </text>

      {CLIENTS.map((c, i) => {
        const y = 70 + i * 62;
        return (
          <g key={c}>
            <path
              className="flow"
              d={`M ${api.x + api.w} ${cy} C 800 ${cy}, 790 ${y + 18}, 840 ${y + 18}`}
              fill="none"
              stroke="#60a5fa"
              strokeOpacity={0.6}
              strokeWidth={1.4}
              style={{ animationDelay: `${i * 0.2}s` }}
            />
            <rect x={840} y={y} width={110} height={36} rx={9} fill="#1f1f27" stroke="#3c3c48" />
            <text x={895} y={y + 23} textAnchor="middle" fill="#e8e5df" fontSize={13}>
              {c}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A short vertical connector between two stacked boxes (viewBox units = CSS px at 300 wide). */
function Connector({ paths, height }: { paths: { d: string; color: string }[]; height: number }) {
  return (
    <svg
      viewBox={`0 0 300 ${height}`}
      className="block h-auto w-full"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((p, i) => (
        <path
          key={i}
          className="flow"
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeOpacity={0.75}
          strokeWidth={1.6}
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </svg>
  );
}

function StackedDiagram() {
  // Five strands leave the answers and join above Work; four leave the API
  // for the clients (each client sits in a quarter of the width).
  const merge = ANSWERS.map((a, i) => {
    const x = 110 + i * 20;
    return { d: `M ${x} 0 C ${x} 22, 150 18, 150 40`, color: a.color };
  });
  const fan = CLIENTS.map((_, i) => {
    const x = 37.5 + i * 75;
    return { d: `M 150 0 C 150 18, ${x} 14, ${x} 34`, color: "#60a5fa" };
  });
  return (
    <div role="img" aria-label={LABEL}>
      <ul className="space-y-2">
        {ANSWERS.map((a) => (
          <li
            key={a.key}
            className="rounded-lg border px-3 py-2"
            style={{ borderColor: `${a.color}88`, background: `${a.color}18` }}
          >
            <div className="text-[13px] font-bold" style={{ color: a.color }}>
              {a.name}
            </div>
            <div className="text-[12px]" style={{ color: DETAIL }}>
              {a.detail}
            </div>
          </li>
        ))}
      </ul>
      <Connector paths={merge} height={40} />
      <div className="mx-auto w-4/5 rounded-2xl border-[1.5px] border-primary-light bg-primary/20 px-4 py-3 text-center">
        <div className="text-[20px] font-bold text-text-heading">Work</div>
        {WORK_LINES.map((line) => (
          <div key={line} className="text-[12px]" style={{ color: DETAIL }}>
            {line}
          </div>
        ))}
      </div>
      <Connector paths={[{ d: "M 150 0 L 150 24", color: "#a78bfa" }]} height={24} />
      <div className="mx-auto w-1/2 rounded-lg border border-border-strong bg-[#1f1f27] py-2.5 text-center text-[14px] font-semibold text-text">
        Optio API
      </div>
      <Connector paths={fan} height={34} />
      <ul className="grid grid-cols-4">
        {CLIENTS.map((c) => (
          <li key={c} className="px-1">
            <div className="rounded-lg border border-border-strong bg-[#1f1f27] py-2 text-center text-[12px] text-text">
              {c}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WorkDiagram() {
  return (
    <figure className="rounded-2xl border border-border bg-bg-card p-4 sm:p-6">
      <div className="sm:hidden">
        <StackedDiagram />
      </div>
      <div className="hidden sm:block">
        <WideDiagram />
      </div>
    </figure>
  );
}
