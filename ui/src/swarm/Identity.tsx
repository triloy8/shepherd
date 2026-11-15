import { useId } from "react";


/** Original Orbit artwork; worker resin uses the mockup's stable seeded palette. */
export function Identity({ kind = "worker", seed = "", large = false }: { kind?: "manager" | "user" | "worker"; seed?: string; large?: boolean }) {
  const id = useId().replaceAll(":", "");
  const cls = `orbit-identity ${large ? "orbit-identity-large" : ""}`;
  if (kind !== "worker") return <svg className={cls} viewBox="0 0 100 100" aria-hidden="true"><Portrait kind={kind} prefix={id} /></svg>;
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.codePointAt(0)!, 16777619) >>> 0;
  const random = () => { let t = state += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const hue = Math.floor(random() * 360); random(); random();
  const x = .25 + random() * .5, y = .35 + random() * .4, inclusion = (hue + 45 + random() * 90) % 360, grain = 1 + Math.floor(random() * 65534);
  const url = (name: string) => `url(#${id}-${name})`;
  const path = "M50 3A46 46 0 1 1 50 95A46 46 0 1 1 50 3Z";
  return <svg className={cls} viewBox="0 0 100 100" aria-hidden="true"><defs>
    <radialGradient id={`${id}-face`} cx=".28" cy=".2" r=".95"><stop stopColor={`hsl(${hue} 45% 88%)`} /><stop offset=".35" stopColor={`hsl(${hue} 52% 70%)`} /><stop offset=".72" stopColor={`hsl(${hue} 54% 48%)`} /><stop offset="1" stopColor={`hsl(${hue} 48% 29%)`} /></radialGradient>
    <radialGradient id={`${id}-tint`} cx={x} cy={y} r=".65"><stop stopColor={`hsl(${inclusion} 65% 72%)`} stopOpacity=".95" /><stop offset=".35" stopColor={`hsl(${inclusion} 60% 65%)`} stopOpacity=".65" /><stop offset="1" stopColor={`hsl(${inclusion} 50% 60%)`} stopOpacity="0" /></radialGradient>
    <radialGradient id={`${id}-satin`} cx=".32" cy=".18" r=".6"><stop stopColor="white" stopOpacity=".5" /><stop offset=".3" stopColor="white" stopOpacity=".2" /><stop offset="1" stopColor="white" stopOpacity="0" /></radialGradient>
    <filter id={`${id}-frost`} colorInterpolationFilters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed={grain} /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncR type="linear" slope=".16" intercept=".9" /><feFuncG type="linear" slope=".16" intercept=".9" /><feFuncB type="linear" slope=".16" intercept=".9" /></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply" /><feComposite in2="SourceGraphic" operator="in" /></filter>
  </defs><path d={path} fill="#10252b" opacity=".22" transform="translate(0 2)" /><g filter={url("frost")}><path d={path} fill={url("face")} /><path d={path} fill={url("tint")} /><path d={path} fill={url("satin")} /></g></svg>;
}

export function OrbitIcon({ name }: { name: "folder" | "plus" }) {
  return <svg className="orbit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={name === "folder" ? "M3 7V5h7l3 3h8v12H3V7Zm0 3h18" : "M12 5v14M5 12h14"} strokeLinejoin="round" /></svg>;
}

/** Keep paint servers and their geometry in the same SVG. External symbol filters
 * render incompletely in some browsers even though the outline still appears. */
function Portrait({ kind, prefix }: { kind: "manager" | "user"; prefix: string }) {
  const key = (name: string) => `${prefix}-${name}`;
  const url = (name: string) => `url(#${key(name)})`;
  return <><defs>
        <clipPath id={key("sky-window")}><circle cx="50" cy="50" r="41" /></clipPath>
        <radialGradient id={key("sky-blue")} cx=".3" cy=".2" r="1">
          <stop stopColor="#279fdc" />
          <stop offset=".65" stopColor="#77ceef" />
          <stop offset="1" stopColor="#d3f1ff" />
        </radialGradient>
        <radialGradient id={key("sky-halo")}>
          <stop offset=".76" stopColor="#84dcff" stopOpacity=".35" />
          <stop offset=".86" stopColor="#6bcfff" stopOpacity=".28" />
          <stop offset="1" stopColor="#66caff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={key("sky-edge")} x1="0" y1="0" x2=".3" y2="1">
          <stop stopColor="#b6eaff" />
          <stop offset=".45" stopColor="#eefbff" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <filter
          id={key("sky-clouds")}
          x="0"
          y="0"
          width="100"
          height="100"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".035 .055"
            numOctaves="5"
            seed="12"
          />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 5 -2.05"
          />
        </filter>
        <radialGradient id={key("cloud-layout")} cx=".32" cy=".45" r=".8">
          <stop stopColor="#000" />
          <stop offset=".25" stopColor="#999" />
          <stop offset=".6" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" />
        </radialGradient>
        <mask id={key("cloud-mask")}>
          <rect width="100" height="100" fill={url("cloud-layout")} />
        </mask>
        <radialGradient id={key("sun-body")}>
          <stop stopColor="#fffef0" />
          <stop offset=".55" stopColor="#fff8ca" />
          <stop offset=".88" stopColor="#ffe68a" />
          <stop offset="1" stopColor="#ffd15b" />
        </radialGradient>
        <radialGradient id={key("sun-corona")}>
          <stop offset=".73" stopColor="#ffba38" stopOpacity=".6" />
          <stop offset=".83" stopColor="#ff951a" stopOpacity=".3" />
          <stop offset="1" stopColor="#ff6710" stopOpacity="0" />
        </radialGradient>
        <filter
          id={key("sun-granulation")}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".32"
            numOctaves="4"
            seed="8"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope=".9" intercept=".45" />
            <feFuncG type="linear" slope=".9" intercept=".45" />
            <feFuncB type="linear" slope=".9" intercept=".45" />
          </feComponentTransfer>
          <feBlend in="SourceGraphic" mode="multiply" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        </defs>{kind === "manager" ? <g>
          <circle cx="50" cy="50" r="49" fill={url("sky-halo")} />
          <circle cx="50" cy="50" r="43" fill={url("sky-edge")} />
          <g clipPath={url("sky-window")}>
            <circle cx="50" cy="50" r="41" fill={url("sky-blue")} />
            <rect
              width="100"
              height="100"
              filter={url("sky-clouds")}
              mask={url("cloud-mask")}
            />
          </g>
          <path
            d="M15 72A42 42 0 0 0 85 72"
            fill="none"
            stroke="#fff"
            strokeWidth="1.7"
            opacity=".9"
          />
        </g> : <g>
          <circle cx="50" cy="50" r="50" fill={url("sun-corona")} />
          <circle cx="50" cy="50" r="42" fill={url("sun-body")} />
          <circle
            cx="50"
            cy="50"
            r="41.5"
            fill={url("sun-body")}
            filter={url("sun-granulation")}
            opacity=".16"
          />
          <circle
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke="#fff4bb"
            strokeWidth=".7"
            opacity=".7"
          />
        </g>}</>;
}
