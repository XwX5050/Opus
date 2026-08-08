export const MOTION = {
  easing: "power3.out",
  panel: { duration: 0.42 },
  dialog: { duration: 0.36 },
  switch: { exit: 0.12, enter: 0.36 },
  list: { stagger: 0.04 },
  content: { duration: 0.28, stagger: 0.035, overlap: 0.18 },
  hover: {
    scale: 1.08,
    enter: { duration: 0.18, ease: "back.out(2.5)" },
    exit: { duration: 0.5, ease: "elastic.out(1, 0.4)" },
  },
} as const;

export const MAX_EDITOR_MOTION_TARGETS = 16;
export const MAX_LIST_MOTION_TARGETS = 32;
