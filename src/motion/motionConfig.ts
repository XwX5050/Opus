export const MOTION = {
  easing: "power3.out",
  panel: { duration: 0.42 },
  dialog: { duration: 0.36 },
  switch: { exit: 0.12, enter: 0.36 },
  list: { stagger: 0.04 },
  content: { duration: 0.28, stagger: 0.035, overlap: 0.18 },
} as const;

export const MAX_EDITOR_MOTION_TARGETS = 16;
export const MAX_LIST_MOTION_TARGETS = 32;
