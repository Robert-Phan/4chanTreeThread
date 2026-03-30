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

// Tree node representing a reply in the thread hierarchy.
// dupNumber tracks "true" copies created by a multi-parent reply.
// Deep-copied descendants keep their original dupNumber values.
type TreeNode = {
  numericId: string;
  replyRecord: ReplyRecord | null;
  children: TreeNode[];
  duplicate: boolean;
  dupNumber: number;
  instanceId: number;
};

let isTransformed = false;
let originalThreadChildren: HTMLElement[] | null = null;
let originalThreadParent: HTMLElement | null = null;
let activeRootNode: TreeNode | null = null;
let activeThreadParent: HTMLElement | null = null;
let activeSubject: HTMLElement | null = null;
let activeArrowClickHandler: ((event: MouseEvent) => void) | null = null;
let nextNodeInstanceId = 1;
const collapsedNodeInstanceIds = new Set<number>();

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

// Remove content for collapsed replies while keeping container, arrows and fileText.
function collapseReplyElement(replyElement: HTMLElement): void {
  const blockquote = replyElement.querySelector<HTMLElement>("blockquote.postMessage");
  if (blockquote) {
    blockquote.remove();
  }

  const fileElement = replyElement.querySelector<HTMLElement>(".file");
  if (fileElement) {
    for (const child of Array.from(fileElement.children)) {
      if (child.classList.contains("fileText")) {
        continue;
      }

      child.remove();
    }
  }
}

function clearActiveTreeState(): void {
  collapsedNodeInstanceIds.clear();
  if (activeArrowClickHandler && activeThreadParent) {
    activeThreadParent.removeEventListener("click", activeArrowClickHandler);
  }

  activeRootNode = null;
  activeThreadParent = null;
  activeSubject = null;
  nextNodeInstanceId = 1;
  activeArrowClickHandler = null;
}

function renderActiveTree(autoCollapseDuplicates: boolean): void {
  if (!activeRootNode || !activeThreadParent || !activeSubject) {
    return;
  }

  const threadParent = activeThreadParent;
  const subject = activeSubject;

  clearThreadContainer(threadParent, subject);
  const firstSeenDupNumberById = new Map<string, number>();

  const renderNode = (node: TreeNode, depth: number): void => {
    if (!node.replyRecord) {
      return;
    }

    const firstSeen = firstSeenDupNumberById.get(node.numericId);
    const isDuplicate = firstSeen !== undefined && firstSeen !== node.dupNumber;
    node.duplicate = isDuplicate;

    if (firstSeen === undefined) {
      firstSeenDupNumberById.set(node.numericId, node.dupNumber);
    }

    if (autoCollapseDuplicates && node.duplicate) {
      collapsedNodeInstanceIds.add(node.instanceId);
    }

    const isCollapsed = collapsedNodeInstanceIds.has(node.instanceId);
    const element = node.replyRecord.element.cloneNode(true) as HTMLElement;
    element.dataset.nodeInstanceId = String(node.instanceId);
    setSideArrows(element, depth);

    const sideArrows = element.querySelector<HTMLElement>(".sideArrows");
    if (sideArrows) {
      sideArrows.style.cursor = "pointer";
    }

    if (isCollapsed) {
      collapseReplyElement(element);
    }

    threadParent.appendChild(element);

    if (isCollapsed) {
      return;
    }

    for (const child of node.children) {
      renderNode(child, depth + 1);
    }
  };

  for (const child of activeRootNode.children) {
    renderNode(child, 1);
  }
}

function attachArrowClickHandler(): void {
  if (!activeThreadParent || !activeSubject) {
    return;
  }

  if (activeArrowClickHandler) {
    activeThreadParent.removeEventListener("click", activeArrowClickHandler);
  }

  activeArrowClickHandler = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const sideArrows = target.closest(".sideArrows") as HTMLElement | null;
    if (!sideArrows) {
      return;
    }

    const replyElement = sideArrows.closest(".postContainer.replyContainer") as HTMLElement | null;
    const instanceIdRaw = replyElement?.dataset.nodeInstanceId;
    if (!instanceIdRaw) {
      return;
    }

    const instanceId = Number(instanceIdRaw);
    if (!Number.isFinite(instanceId)) {
      return;
    }

    if (collapsedNodeInstanceIds.has(instanceId)) {
      collapsedNodeInstanceIds.delete(instanceId);
    } else {
      collapsedNodeInstanceIds.add(instanceId);
    }

    renderActiveTree(false);
  };

  activeThreadParent.addEventListener("click", activeArrowClickHandler);
}

// Build tree structure from parent-child relationships.
// Replies with multiple parents produce true copies (dupNumber 0..n-1).
// Descendants are deep-copied per branch but preserve their own dupNumber.
function buildTreeStructure(
  subjectNumericId: string | null,
  replyRecords: ReplyRecord[],
  replyIdSet: Set<string>
): { success: boolean; reason?: string; rootNode?: TreeNode } {
  const subjectNodeId = subjectNumericId ?? "__subject_root__";
  const parentsByChildId = new Map<string, string[]>();
  const childrenByParentId = new Map<string, string[]>();
  const replyByNumericId = new Map(replyRecords.map((record) => [record.numericId, record]));

  // Build parent links and parent->children order from reply links.
  // 1) valid linked parents if present
  // 2) otherwise subject root
  for (const record of replyRecords) {
    const validParents = record.linkedParentIds.filter(
      (linkedId) => linkedId === subjectNumericId || replyIdSet.has(linkedId)
    );

    const parentIds = (validParents.length > 0 ? validParents : [subjectNodeId]).map((parentId) =>
      parentId === subjectNumericId ? subjectNodeId : parentId
    );

    parentsByChildId.set(record.numericId, parentIds);

    for (const parentId of parentIds) {
      const existing = childrenByParentId.get(parentId) ?? [];
      existing.push(record.numericId);
      childrenByParentId.set(parentId, existing);
    }
  }

  // Build one node instance with the provided true-copy dupNumber.
  function buildNodeInstance(numericId: string, dupNumber: number): TreeNode | null {
    const replyRecord = replyByNumericId.get(numericId);
    if (!replyRecord) {
      return null;
    }

    const children: TreeNode[] = [];
    const childIds = childrenByParentId.get(numericId) ?? [];

    for (const childId of childIds) {
      const parentChoices = parentsByChildId.get(childId) ?? [subjectNodeId];
      const childDupNumber = Math.max(0, parentChoices.indexOf(numericId));
      const childNode = buildNodeInstance(childId, childDupNumber);
      if (childNode) {
        children.push(childNode);
      }
    }

    return {
      numericId,
      replyRecord,
      children,
      duplicate: false,
      dupNumber,
      instanceId: nextNodeInstanceId++,
    };
  }

  // Build virtual root node and its children in original order.
  const rootChildren: TreeNode[] = [];
  const rootChildIds = childrenByParentId.get(subjectNodeId) ?? [];

  for (const childId of rootChildIds) {
    const parentChoices = parentsByChildId.get(childId) ?? [subjectNodeId];
    const childDupNumber = Math.max(0, parentChoices.indexOf(subjectNodeId));
    const childNode = buildNodeInstance(childId, childDupNumber);
    if (childNode) {
      rootChildren.push(childNode);
    }
  }

  const rootNode: TreeNode = {
    numericId: subjectNodeId,
    replyRecord: null,
    children: rootChildren,
    duplicate: false,
    dupNumber: 0,
    instanceId: 0,
  };

  return { success: true, rootNode };
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

// Build and render tree structure from reply records, detecting and marking duplicate node instances.
function reconstructReplyTree(subject: HTMLElement, replies: HTMLElement[]): { success: boolean; reason?: string } {
  const subjectNumericId = parsePcNumericId(subject.id);
  const replyRecords = buildReplyRecords(replies);
  const replyIdSet = new Set(replyRecords.map((record) => record.numericId));

  if (replyRecords.length === 0) {
    return { success: false, reason: "No valid reply records to build tree from." };
  }

  // Build actual tree structure from reply records.
  const treeResult = buildTreeStructure(subjectNumericId, replyRecords, replyIdSet);
  if (!treeResult.success || !treeResult.rootNode) {
    return { success: false, reason: treeResult.reason };
  }

  const threadParent = subject.parentElement;
  if (!threadParent) {
    return { success: false, reason: "Subject container has no parent." };
  }

  clearThreadContainer(threadParent, subject);

  activeRootNode = treeResult.rootNode;
  activeThreadParent = threadParent;
  activeSubject = subject;

  attachArrowClickHandler();

  // Render replies from tree and auto-collapse duplicates instead of tagging text.
  renderActiveTree(true);

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
    clearActiveTreeState();
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
    clearActiveTreeState();

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