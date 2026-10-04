// How ids read in the HUD: 'living_room' -> 'Living room'.
export const human = (s: unknown): string => {
  const t = String(s ?? '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
