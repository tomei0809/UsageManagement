import { useEffect, useState } from "react";

/** 依存を増やさない最小のハッシュルーター(#/services/3 など) */
export type Route =
  | { name: "dashboard" }
  | { name: "service-new" }
  | { name: "service"; id: number }
  | { name: "service-edit"; id: number }
  | { name: "settings" }
  | { name: "not-found" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { name: "dashboard" };
  if (path === "/services/new") return { name: "service-new" };
  if (path === "/settings") return { name: "settings" };
  const m = path.match(/^\/services\/(\d+)(\/edit)?$/);
  if (m) return m[2] ? { name: "service-edit", id: Number(m[1]) } : { name: "service", id: Number(m[1]) };
  return { name: "not-found" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const navigate = (path: string) => {
  location.hash = path;
};
