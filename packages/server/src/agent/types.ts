export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}
