Create a browser extension that creates a page_action button that appears in `example.com` (I will change the URl later). When clicked on, it does the following thing:

- Get all *replies* using the query ".postContainer.replyContainer"
- Get the *subject* using ".opContainer"
- Get the *thumbnail* using query ".fileThumb"
- Obtain the buffer height by taking the offset bottom of thumbnail and subtracting by the offset top of the *first reply*
- Insert, as a brother element just after the subject, the following snippet, with the buffer height inserted:

```
<div class="postContainer replyContainer" id="bufferContainer">
    <div id="buffer" class="post reply" style="height: {bufferHeight}px;padding: 2px 0;border: none;"></div>
</div>
```

This extension should be written in Typescript, using Manifest v3. Afterwards, give instruction on how to test this instruction in Firefox.

===

Using the replies collected, transform them in the following manner:

- Each reply element (and the subject too) has an `id` attribute in the format of `pc{id number}`. 
- The 2nd child of each reply element is a div with the classes 'post reply'. This element itself has children, one of which is a blockquote with class 'postMessage'.
- The blockquote itself has children. If, of those childre, there are links where the href is in the format `p{id number}`, then, for each linked-reply identified by those linked id-numbers, the reply will become a child-node of that linked-reply.
- If a reply does not have links (again, only links in the `p{number format}`, not links in general), then it is by default the child of the subject. If it does have links it is no longer the link of the subject, ubless the subject is explicit linked
- Using this information of which replies are children of which other, construct a tree structure for the thread

For example, given a pseudo-list of replies like this:

```
Reply 1 { Reply 1 texts }

Reply 2 { [link to 1] Reply 2 texts }

Reply 3 { [link to 1] [link to 2] Reply 2 texts }

Reply 4 { [link to subject] [link to 2] Reply 2 texts }
```

We will have a tree where:
- The subject is the root
- Reply 1 is the child of the root
- Reply 2 is the child of Reply 1
- Reply 3 is both the child of 1 and 2. Meaning, conceptually, there exists two copies of reply 3 in the tree, one of which is the child of 1 and the other the child of 2
- Reply 4 is both the child of the subject and 2. Again, there are two copies of 4

This tree should be constructed so that the original order of the replies are preserved; the children of the subjects should all be ordered the same as they were in the original list, and likewise the children of any particular reply.

From the tree, reconstruct the HTML structure of the website. First, given the parent of the reply elements, delete all of its children, excepting the first element and the potential `#bufferContainer` right after. Then, traverse the tree, where after each node is visited, visit the node's children in the list order, inserting the reply element into the parent at each visit.

In the example tree above, we would have:
- Reply 1 inserted first
- Reply 1 has two children, Reply 2 and 3. Reply 2 is inserted first
- Reply 2 has two children, Reply 3 and 4, so those get inserted in that order
- Going back to Reply 1's children, another copy of Reply 3 is inserted
- Going back up to the root, Reply 4 is next, so another copy is inserted

In order to convey depth, each reply element has an (already existing) div child with the class 'sideArrows'. Replace the text of sideArrows with a number of `>` based on its depth. For example, at depth 1, being the reply to the subject, there is 1 arrow. A child of that reply will have 2 arrows, and so on.