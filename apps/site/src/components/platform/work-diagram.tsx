/**
 * The article's diagram: the five answers flow into one model of work, one
 * API serves it, and every client reads the same list. The dashed lines
 * move (CSS, `.flow`), and hold still with reduced motion.
 */

const ANSWERS = [
  { label: "When", detail: "now · cron · webhook · ticket · event", color: "#a78bfa" },
  { label: "Where", detail: "pod · repo · your machine", color: "#60a5fa" },
  { label: "Who", detail: "7 agent runtimes · a shell", color: "#f0a040" },
  { label: "Environment", detail: "MCP · connections · skills · secrets", color: "#818cf8" },
  { label: "Then", detail: "exits · until merged · waits · persists", color: "#34d399" },
];

const CLIENTS = ["Web", "iOS", "Android", "CLI"];

const W = 960;
const H = 360;
const ROW = 66;
const TOP = 22;

export function WorkDiagram() {
  const work = { x: 380, y: 125, w: 200, h: 110 };
  const api = { x: 630, y: 155, w: 140, h: 50 };
  const cy = work.y + work.h / 2;
  return (
    <figure className="rounded-2xl border border-border bg-bg-card p-4 sm:p-6">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="When, Where, Who, Environment, and Then flow into one model of work, served by one API to the web, iOS, Android, and CLI clients."
      >
        {ANSWERS.map((a, i) => {
          const y = TOP + i * ROW;
          const sy = y + 22;
          return (
            <g key={a.label}>
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
                {a.label}
              </text>
              <text x={24} y={y + 35} fill="#a9a5b1" fontSize={11}>
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
        {["one definitions table", "one runs table"].map((line, i) => (
          <text
            key={line}
            x={work.x + work.w / 2}
            y={cy + 20 + i * 15}
            textAnchor="middle"
            fill="#a9a5b1"
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
          fontFamily="ui-monospace, monospace"
        >
          /api/work
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
    </figure>
  );
}
