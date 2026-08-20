import {
  V2_HOST_ROUTE_TABLES,
  type V2HostRoute,
  type V2RouteAlphabet,
} from "./generated/v2-codec-model";

export const V2_ROUTE_ALPHABETS: Readonly<Record<V2RouteAlphabet, string>> = {
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  decimal: "0123456789",
  hex: "0123456789abcdef",
  "lower-hyphen": "abcdefghijklmnopqrstuvwxyz-",
};

export function v2HostRoutes(host: string | null): readonly V2HostRoute[] {
  return host ? V2_HOST_ROUTE_TABLES[host] ?? [] : [];
}

export function v2RouteIdBits(routes: readonly V2HostRoute[]): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, routes.length))));
}

export function v2RouteAlphabet(name: V2RouteAlphabet): string {
  return V2_ROUTE_ALPHABETS[name];
}
