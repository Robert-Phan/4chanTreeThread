/// <reference types="chrome" />

// Use page offsets so measurements are stable even when the user is scrolled.
function elementTop(element: HTMLElement): number {
  return element.getBoundingClientRect().top + window.scrollY;
}

function elementBottom(element: HTMLElement): number {
  return element.getBoundingClientRect().bottom + window.scrollY;
}

type OperationResult = {
  success: boolean;
  reason?: string;
  bufferHeight?: number;
  transformed?: boolean;
};

type ReplyRecord = {
  id: string;
  numericId: string;
  element: HTMLElement;
  linkedParentIds: string[];
};

let isTransformed = false;
let originalThreadChildren: HTMLElement[] | null = null;
let originalThreadParent: HTMLElement | null = null;

// IDs are expected as pc{number}, e.g. pc123456.
function parsePcNumericId(rawId: string | null): string | null {
  if (!rawId) {
    return null;
  }

  const match = /^pc(\d+)$/.exec(rawId.trim());
  return match?.[1] ?? null;
}

// Linked replies are expected as p{number} or #p{number}.
function parseLinkedNumericId(href: string): string | null {
  const normalized = href.trim();
  const match = /(?:^|#)p(\d+)$/.exec(normalized);
  return match?.[1] ?? null;
}

// Collect each reply plus the unique set of linked parent reply IDs referenced in its postMessage.
function buildReplyRecords(replies: HTMLElement[]): ReplyRecord[] {
  const records: ReplyRecord[] = [];

  for (const reply of replies) {
    if (reply.id === "bufferContainer") {
      continue;
    }

    const numericId = parsePcNumericId(reply.id);
    if (!numericId) {
      continue;
    }

    const postMessage = reply.querySelector<HTMLElement>(".post.reply blockquote.postMessage");
    const anchors = postMessage
      ? Array.from(postMessage.querySelectorAll<HTMLAnchorElement>("a[href]"))
      : [];

    const linkedParentIds: string[] = [];
    const seen = new Set<string>();

    for (const anchor of anchors) {
      const parsedId = parseLinkedNumericId(anchor.getAttribute("href") ?? "");
      if (!parsedId || seen.has(parsedId)) {
        continue;
      }

      seen.add(parsedId);
      linkedParentIds.push(parsedId);
    }

    records.push({
      id: reply.id,
      numericId,
      element: reply,
      linkedParentIds,
    });
  }

  return records;
}

// Depth is represented visually by repeated side arrows.
function setSideArrows(replyElement: HTMLElement, depth: number): void {
  const sideArrows = replyElement.querySelector<HTMLElement>(".sideArrows");
  if (!sideArrows) {
    return;
  }

  sideArrows.textContent = ">>" + "•>>".repeat(depth-1);
}

// Keep only the subject and optional buffer node; everything else gets rebuilt from the tree.
function clearThreadContainer(parent: HTMLElement, subject: HTMLElement): void {
  for (const child of Array.from(parent.children)) {
    if (child === subject) {
      continue;
    }

    if (child.id === "bufferContainer") {
      continue;
    }

    child.remove();
  }
}

function cloneReplyForDepth(replyElement: HTMLElement, depth: number): HTMLElement {
  const clone = replyElement.cloneNode(true) as HTMLElement;
  setSideArrows(clone, depth);
  return clone;
}

// Keep a full snapshot of current thread children so we can restore on the next click.
function snapshotThreadChildren(parent: HTMLElement): HTMLElement[] {
  return Array.from(parent.children).map((child) => child.cloneNode(true) as HTMLElement);
}

// Replace all current children with a previously captured snapshot.
function restoreThreadFromSnapshot(parent: HTMLElement, snapshot: HTMLElement[]): void {
  parent.replaceChildren(...snapshot.map((node) => node.cloneNode(true) as HTMLElement));
}

// Insert or update #bufferContainer right after the subject and return the computed height.
function insertOrUpdateBuffer(subject: HTMLElement, firstReply: HTMLElement, thumbnail: HTMLElement): number {
  const bufferHeight = Math.max(0, Math.round(elementBottom(thumbnail) - elementTop(firstReply)));

  const existingBuffer = document.getElementById("bufferContainer");
  if (existingBuffer) {
    existingBuffer.remove();
  }

  const bufferContainer = document.createElement("div");
  bufferContainer.className = "postContainer replyContainer";
  bufferContainer.id = "bufferContainer";

  const buffer = document.createElement("div");
  buffer.id = "buffer";
  buffer.className = "post reply";
  buffer.style.cssText = `height: ${bufferHeight}px;padding: 2px 0;border: none;`;

  bufferContainer.appendChild(buffer);
  subject.insertAdjacentElement("afterend", bufferContainer);

  return bufferHeight;
}

// Build parent->children relationships, then DFS-reinsert replies in source order.
function reconstructReplyTree(subject: HTMLElement, replies: HTMLElement[]): { success: boolean; reason?: string } {
  const subjectNumericId = parsePcNumericId(subject.id);
  const replyRecords = buildReplyRecords(replies);
  const replyIdSet = new Set(replyRecords.map((record) => record.numericId));

  if (replyRecords.length === 0) {
    return { success: false, reason: "No valid reply records to build tree from." };
  }

  const subjectNodeId = subjectNumericId ?? "__subject_root__";
  const childrenByParent = new Map<string, string[]>();
  const replyByNumericId = new Map(replyRecords.map((record) => [record.numericId, record]));

  // Parent selection rule:
  // 1) valid linked parents if present
  // 2) otherwise subject root
  for (const record of replyRecords) {
    const validParents = record.linkedParentIds.filter(
      (linkedId) => linkedId === subjectNumericId || replyIdSet.has(linkedId)
    );

    const parentIds = validParents.length > 0 ? validParents : [subjectNodeId];

    for (const parentId of parentIds) {
      const normalizedParent = parentId === subjectNumericId ? subjectNodeId : parentId;
      const existing = childrenByParent.get(normalizedParent) ?? [];
      existing.push(record.numericId);
      childrenByParent.set(normalizedParent, existing);
    }
  }

  const threadParent = subject.parentElement;
  if (!threadParent) {
    return { success: false, reason: "Subject container has no parent." };
  }

  clearThreadContainer(threadParent, subject);

  // Replies linked by multiple parents can appear multiple times; clone after first insertion.
  const seenInsertions = new Map<string, number>();

  // Guard with an ancestor set to avoid infinite recursion on cyclic links.
  const insertSubtree = (parentId: string, depth: number, ancestors: Set<string>): void => {
    const children = childrenByParent.get(parentId) ?? [];

    for (const childId of children) {
      if (ancestors.has(childId)) {
        continue;
      }

      const replyRecord = replyByNumericId.get(childId);
      if (!replyRecord) {
        continue;
      }

      const count = seenInsertions.get(childId) ?? 0;
      const nodeToInsert = count === 0 ? replyRecord.element : cloneReplyForDepth(replyRecord.element, depth);

      if (count === 0) {
        setSideArrows(nodeToInsert, depth);
      }

      seenInsertions.set(childId, count + 1);
      threadParent.appendChild(nodeToInsert);

      const nextAncestors = new Set(ancestors);
      nextAncestors.add(childId);
      insertSubtree(childId, depth + 1, nextAncestors);
    }
  };

  insertSubtree(subjectNodeId, 1, new Set());
  return { success: true };
}

function processThread(): OperationResult {
  // Toggle off path: restore the exact original DOM structure captured on first click.
  if (isTransformed) {
    if (!originalThreadParent || !originalThreadChildren) {
      isTransformed = false;
      return { success: false, reason: "Missing original thread snapshot for restore." };
    }

    restoreThreadFromSnapshot(originalThreadParent, originalThreadChildren);
    isTransformed = false;
    originalThreadChildren = null;
    originalThreadParent = null;
    return { success: true, transformed: false };
  }

  // Toggle on path: gather all required nodes and fail fast if critical nodes are missing.
  const replies = Array.from(
    document.querySelectorAll<HTMLElement>(".postContainer.replyContainer")
  );
  const firstReply = replies.find((reply) => reply.id !== "bufferContainer");
  const subject = document.querySelector<HTMLElement>(".opContainer");
  const thumbnail = document.querySelector<HTMLElement>(".fileThumb");
  const threadParent = subject?.parentElement ?? null;

  if (!firstReply) {
    return { success: false, reason: "No replies found." };
  }

  if (!subject) {
    return { success: false, reason: "Subject container not found." };
  }

  if (!thumbnail) {
    return { success: false, reason: "Thumbnail not found." };
  }

  if (!threadParent) {
    return { success: false, reason: "Subject container has no parent." };
  }

  // Save original thread layout once, before any buffer insertion/reconstruction happens.
  originalThreadParent = threadParent;
  originalThreadChildren = snapshotThreadChildren(threadParent);

  // Step 1: inject/update the spacer buffer directly under the subject.
  const bufferHeight = insertOrUpdateBuffer(subject, firstReply, thumbnail);

  // Step 2: build and render the reply tree from quote-link relationships.
  const reconstructResult = reconstructReplyTree(subject, replies);
  if (!reconstructResult.success) {
    // Roll back partial changes when tree reconstruction fails.
    if (originalThreadParent && originalThreadChildren) {
      restoreThreadFromSnapshot(originalThreadParent, originalThreadChildren);
    }
    originalThreadChildren = null;
    originalThreadParent = null;

    return {
      success: false,
      reason: reconstructResult.reason,
      bufferHeight,
      transformed: false,
    };
  }

  isTransformed = true;
  return { success: true, bufferHeight, transformed: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "INSERT_BUFFER") {
    return;
  }

  sendResponse(processThread());
});