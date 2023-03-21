/*
  1Password Extension

  Lovingly handcrafted by Dave Teare, Michael Fey, Rad Azzouz, and Roustem Karimov.
  Copyright (c) 2014 AgileBits. All rights reserved.

  ================================================================================

  Copyright (c) 2014 AgileBits Inc.

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  */

import AutofillPageDetails from "../models/autofill-page-details";
import AutofillScript from '../models/autofill-script';

/*
  MODIFICATIONS FROM ORIGINAL

  1.  Populate isFirefox
  2.  Remove isChrome and isSafari since they are not used.
  3.  Unminify and format to meet Mozilla review requirements.
  4.  Remove unnecessary input types from getFormElements query selector and limit number of elements returned.
  5.  Remove fakeTested prop.
  6.  Rename com.agilebits.* stuff to com.bitwarden.*
  7.  Remove "some useful globals" on window
  8.  Add ability to autofill span[data-bwautofill] elements
  9.  Add new handler, for new command that responds with page details in response callback
  10. Handle sandbox iframe and sandbox rule in CSP
  11. Work on array of saved urls instead of just one to determine if we should autofill non-https sites
  12. Remove setting of attribute com.browser.browser.userEdited on user-inputs
  13. Handle null value URLs in urlNotSecure
  14. Implement new HTML element query logic to be able to traverse into ShadowRoot
  */

/*
 * `openOrClosedShadowRoot` is only available to WebExtensions.
 * We need to use the correct implementation based on browser.
 */
// START MODIFICATION
var getShadowRoot: (element: Element) => Element;

if (chrome.dom && chrome.dom.openOrClosedShadowRoot) {
  // Chromium 88+
  // https://developer.chrome.com/docs/extensions/reference/dom/
  getShadowRoot = function (element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return chrome.dom.openOrClosedShadowRoot(element);
  };
} else {
  getShadowRoot = function (element) {
    // `openOrClosedShadowRoot` is currently available for Firefox 63+
    // https://developer.mozilla.org/en-US/docs/Web/API/Element/openOrClosedShadowRoot
    // Fallback to usual shadowRoot if it doesn't exist, which will only find open ShadowRoots, not closed ones.
    // https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot#browser_compatibility
    return element.openOrClosedShadowRoot || element.shadowRoot;
  };
}

/*
 * Returns elements like Document.querySelectorAll does, but traverses the document and shadow
 * roots, yielding a visited node only if it passes the predicate in filterCallback.
 */
function queryDocAll(
  doc: Document,
  rootEl: Element,
  filterCallback: (el: Element) => boolean
): Node[] {
  var accumulatedNodes: Element[] = [];

  // mutates accumulatedNodes
  accumulatingQueryDocAll(doc, rootEl, filterCallback, accumulatedNodes);

  return accumulatedNodes;
}

function accumulatingQueryDocAll(
  doc: Document,
  rootEl: Element,
  filterCallback: (el: Element) => boolean,
  accumulatedNodes: Element[]
): void {
  var treeWalker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  var node: Element;

  while ((node = treeWalker.nextNode() as Element)) {
    if (filterCallback(node)) {
      accumulatedNodes.push(node);
    }

    // If node contains a ShadowRoot we want to step into it and also traverse all child nodes inside.
    var nodeShadowRoot = getShadowRoot(node);

    if (!nodeShadowRoot) {
      continue;
    }

    // recursively traverse into ShadowRoot
    accumulatingQueryDocAll(doc, nodeShadowRoot, filterCallback, accumulatedNodes);
  }
}

/*
 * Returns an element like Document.querySelector does, but traverses the document and shadow
 * roots, yielding a visited node only if it passes the predicate in filterCallback.
 */
function queryDoc(
  doc: Document,
  rootEl: Element,
  filterCallback: (el: Element) => boolean
): Element {
  var treeWalker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  var node: Element;

  while ((node = treeWalker.nextNode() as Element)) {
    if (filterCallback(node)) {
      return node;
    }

    // If node contains a ShadowRoot we want to step into it and also traverse all child nodes inside.
    var nodeShadowRoot = getShadowRoot(node);

    if (!nodeShadowRoot) {
      continue;
    }

    // recursively traverse into ShadowRoot
    var subQueryResult = queryDoc(doc, nodeShadowRoot, filterCallback);

    if (subQueryResult) {
      return subQueryResult;
    }
  }

  return null;
}
// END MODIFICATION

function collect(document: any): string {
  // START MODIFICATION
  var isFirefox =
    navigator.userAgent.indexOf("Firefox") !== -1 || navigator.userAgent.indexOf("Gecko/") !== -1;
  // END MODIFICATION

  document.elementsByOPID = {};

  function getPageDetails(theDoc: any, oneShotId: string) {
    // start helpers

    /**
     * For a given element `el`, returns the value of the attribute `attrName`.
     * @param {HTMLElement} el
     * @param {string} attrName
     * @returns {string} The value of the attribute
     */
    function getElementAttrValue(el: any, attrName: string) {
      var attrVal = el[attrName];
      if ("string" == typeof attrVal) {
        return attrVal;
      }
      attrVal = el.getAttribute(attrName);
      return "string" == typeof attrVal ? attrVal : null;
    }

    /**
     * Returns the value of the given element.
     * @param {HTMLElement} el
     * @returns {any} Value of the element
     */
    function getElementValue(el: any) {
      switch (toLowerString(el.type)) {
        case "checkbox":
          return el.checked ? "✓" : "";

        case "hidden":
          el = el.value;
          if (!el || "number" != typeof el.length) {
            return "";
          }
          254 < el.length && (el = el.substr(0, 254) + "...SNIPPED");
          return el;

        default:
          // START MODIFICATION
          if (!el.type && el.tagName.toLowerCase() === "span") {
            return el.innerText;
          }
          // END MODIFICATION
          return el.value;
      }
    }

    /**
     * If `el` is a `<select>` element, return an object containing an array of all of the options' `text` properties.
     */
    function getSelectElementOptions(el: HTMLSelectElement): { options: string[] } {
      if (!el.options) {
        return null;
      }

      var options = Array.prototype.slice
        .call(el.options)
        .map(function (option: HTMLOptionElement) {
          var optionText = option.text
            ? toLowerString(option.text)
                .replace(/\\s/gm, "")
                .replace(/[~`!@$%^&*()\\-_+=:;'\"\\[\\]|\\\\,<.>\\?]/gm, "")
            : null;

          return [optionText ? optionText : null, option.value];
        });

      return {
        options: options,
      };
    }

    /**
     * If `el` is in a data table, get the label in the row directly above it
     * @param {HTMLElement} el
     * @returns {string} A string containing the label, or null if not found
     */
    function getLabelTop(el: any): string {
      var parent;

      // Traverse up the DOM until we reach either the top or the table data element containing our field
      for (el = el.parentElement || el.parentNode; el && "td" != toLowerString(el.tagName); ) {
        el = el.parentElement || el.parentNode;
      }

      // If we reached the top, return null
      if (!el || void 0 === el) {
        return null;
      }

      // Establish the parent of the table and make sure it's a table row
      parent = el.parentElement || el.parentNode;
      if ("tr" != parent.tagName.toLowerCase()) {
        return null;
      }

      // Get the previous sibling of the table row and make sure it's a table row
      parent = parent.previousElementSibling;
      if (
        !parent ||
        "tr" != (parent.tagName + "").toLowerCase() ||
        (parent.cells && el.cellIndex >= parent.cells.length)
      ) {
        return null;
      }

      // Parent is established as the row above the table data element containing our field
      // Now let's traverse over to the cell in the same column as our field
      el = parent.cells[el.cellIndex];

      // Get the contents of this label
      var elText = el.textContent || el.innerText;
      return (elText = cleanText(elText));
    }

    /**
     * Get the contents of the elements that are labels for `el`
     * @param {HTMLElement} el
     * @returns {string} A string containing all of the `innerText` or `textContent` values for all elements that are labels for `el`
     */
    function getLabelTag(el: any): string {
      var docLabel,
        theLabels: any[] = [];

      if (el.labels && el.labels.length && 0 < el.labels.length) {
        theLabels = Array.prototype.slice.call(el.labels);
      } else {
        if (el.id) {
          // START MODIFICATION
          var elId = JSON.stringify(el.id);
          var labelsByReferencedId = queryDocAll(theDoc, theDoc.body, function (node) {
            return node.nodeName === "LABEL" && node.htmlFor === elId;
          });
          theLabels = theLabels.concat(labelsByReferencedId);
          // END MODIFICATION
        }

        if (el.name) {
          // START MODIFICATION
          var elName = JSON.stringify(el.name);
          docLabel = queryDocAll(theDoc, theDoc.body, function (node) {
            return node.nodeName === "LABEL" && node.htmlFor === elName;
          });
          // END MODIFICATION

          for (var labelIndex = 0; labelIndex < docLabel.length; labelIndex++) {
            if (-1 === theLabels.indexOf(docLabel[labelIndex])) {
              theLabels.push(docLabel[labelIndex]);
            }
          }
        }

        for (var theEl = el; theEl && theEl != theDoc; theEl = theEl.parentNode) {
          if ("label" === toLowerString(theEl.tagName) && -1 === theLabels.indexOf(theEl)) {
            theLabels.push(theEl);
          }
        }
      }

      if (0 === theLabels.length) {
        theEl = el.parentNode;
        if (
          "dd" === theEl.tagName.toLowerCase() &&
          null !== theEl.previousElementSibling &&
          "dt" === theEl.previousElementSibling.tagName.toLowerCase()
        ) {
          theLabels.push(theEl.previousElementSibling);
        }
      }

      if (0 > theLabels.length) {
        return null;
      }

      return theLabels
        .map(function (l) {
          return (l.textContent || l.innerText)
            .replace(/^\\s+/, "")
            .replace(/\\s+$/, "")
            .replace("\\n", "")
            .replace(/\\s{2,}/, " ");
        })
        .join("");
    }

    /**
     * Add property `prop` with value `val` to the object `obj`
     * @param {object} obj
     * @param {string} prop
     * @param {any} val
     * @param {*} d
     */
    function addProp(obj: any, prop: any, val: any, d: any = undefined) {
      if ((0 !== d && d === val) || null === val || void 0 === val) {
        return;
      }

      obj[prop] = val;
    }

    /**
     * Converts the string `s` to lowercase
     * @param {string} s
     * @returns Lowercase string
     */
    function toLowerString(s: string) {
      return "string" === typeof s ? s.toLowerCase() : ("" + s).toLowerCase();
    }
    // START MODIFICATION
    // renamed queryDoc to queryDocAll and moved to top
    // END MODIFICATION
    // end helpers

    var theView = theDoc.defaultView ? theDoc.defaultView : window;

    // get all the docs
    // START MODIFICATION
    var formNodes = queryDocAll(theDoc, theDoc.body, function (el) {
      return el.nodeName === "FORM";
    });
    var theForms = formNodes.map(function (formEl, elIndex) {
      // END MODIFICATION
      var op = {},
        formOpId = "__form__" + elIndex;

      formEl.opid = formOpId;
      op.opid = formOpId;
      addProp(op, "htmlName", getElementAttrValue(formEl, "name"));
      addProp(op, "htmlID", getElementAttrValue(formEl, "id"));
      formOpId = getElementAttrValue(formEl, "action");
      formOpId = new URL(formOpId, window.location.href);
      addProp(op, "htmlAction", formOpId ? formOpId.href : null);
      addProp(op, "htmlMethod", getElementAttrValue(formEl, "method"));

      return op;
    });

    // get all the form fields
    var theFields = Array.prototype.slice
      .call(getFormElements(theDoc, 50))
      .map(function (el, elIndex) {
        var field: Record<string, any> = {},
          opId = "__" + elIndex,
          elMaxLen = -1 == el.maxLength ? 999 : el.maxLength;

        if (!elMaxLen || ("number" === typeof elMaxLen && isNaN(elMaxLen))) {
          elMaxLen = 999;
        }

        theDoc.elementsByOPID[opId] = el;
        el.opid = opId;
        field.opid = opId;
        field.elementNumber = elIndex;
        addProp(field, "maxLength", Math.min(elMaxLen, 999), 999);
        field.visible = isElementVisible(el);
        field.viewable = isElementViewable(el);
        addProp(field, "htmlID", getElementAttrValue(el, "id"));
        addProp(field, "htmlName", getElementAttrValue(el, "name"));
        addProp(field, "htmlClass", getElementAttrValue(el, "class"));
        addProp(field, "tabindex", getElementAttrValue(el, "tabindex"));
        addProp(field, "title", getElementAttrValue(el, "title"));

        // START MODIFICATION
        var elTagName = el.tagName.toLowerCase();
        addProp(field, "tagName", elTagName);

        if (elTagName === "span") {
          return field;
        }
        // END MODIFICATION

        if ("hidden" != toLowerString(el.type)) {
          addProp(field, "label-tag", getLabelTag(el));
          addProp(field, "label-data", getElementAttrValue(el, "data-label"));
          addProp(field, "label-aria", getElementAttrValue(el, "aria-label"));
          addProp(field, "label-top", getLabelTop(el));
          var labelArr: any = [];
          for (var sib = el; sib && sib.nextSibling; ) {
            sib = sib.nextSibling;
            if (isKnownTag(sib)) {
              break;
            }
            checkNodeType(labelArr, sib);
          }
          addProp(field, "label-right", labelArr.join(""));
          labelArr = [];
          shiftForLeftLabel(el, labelArr);
          labelArr = labelArr.reverse().join("");
          addProp(field, "label-left", labelArr);
          addProp(field, "placeholder", getElementAttrValue(el, "placeholder"));
        }

        addProp(field, "rel", getElementAttrValue(el, "rel"));
        addProp(field, "type", toLowerString(getElementAttrValue(el, "type")));
        addProp(field, "value", getElementValue(el));
        addProp(field, "checked", el.checked, false);
        addProp(
          field,
          "autoCompleteType",
          el.getAttribute("x-autocompletetype") ||
            el.getAttribute("autocompletetype") ||
            el.getAttribute("autocomplete"),
          "off"
        );
        addProp(field, "disabled", el.disabled);
        addProp(field, "readonly", el.b || el.readOnly);
        addProp(field, "selectInfo", getSelectElementOptions(el));
        addProp(field, "aria-hidden", "true" == el.getAttribute("aria-hidden"), false);
        addProp(field, "aria-disabled", "true" == el.getAttribute("aria-disabled"), false);
        addProp(field, "aria-haspopup", "true" == el.getAttribute("aria-haspopup"), false);
        addProp(field, "data-unmasked", el.dataset.unmasked);
        addProp(field, "data-stripe", getElementAttrValue(el, "data-stripe"));
        addProp(field, "onepasswordFieldType", el.dataset.onepasswordFieldType || el.type);
        addProp(field, "onepasswordDesignation", el.dataset.onepasswordDesignation);
        addProp(field, "onepasswordSignInUrl", el.dataset.onepasswordSignInUrl);
        addProp(field, "onepasswordSectionTitle", el.dataset.onepasswordSectionTitle);
        addProp(field, "onepasswordSectionFieldKind", el.dataset.onepasswordSectionFieldKind);
        addProp(field, "onepasswordSectionFieldTitle", el.dataset.onepasswordSectionFieldTitle);
        addProp(field, "onepasswordSectionFieldValue", el.dataset.onepasswordSectionFieldValue);

        if (el.form) {
          field.form = getElementAttrValue(el.form, "opid");
        }

        // START MODIFICATION
        //addProp(field, 'fakeTested', checkIfFakeTested(field, el), false);
        // END MODIFICATION

        return field;
      });

    // test form fields
    theFields
      .filter(function (f: any) {
        return f.fakeTested;
      })
      .forEach(function (f: any) {
        var el = theDoc.elementsByOPID[f.opid];
        el.getBoundingClientRect();

        var originalValue = el.value;
        // click it
        !el || (el && "function" !== typeof el.click) || el.click();
        focusElement(el, false);

        el.dispatchEvent(doEventOnElement(el, "keydown"));
        el.dispatchEvent(doEventOnElement(el, "keypress"));
        el.dispatchEvent(doEventOnElement(el, "keyup"));

        el.value !== originalValue && (el.value = originalValue);

        el.click && el.click();
        f.postFakeTestVisible = isElementVisible(el);
        f.postFakeTestViewable = isElementViewable(el);
        f.postFakeTestType = el.type;

        var elValue = el.value;

        var event1 = el.ownerDocument.createEvent("HTMLEvents"),
          event2 = el.ownerDocument.createEvent("HTMLEvents");
        el.dispatchEvent(doEventOnElement(el, "keydown"));
        el.dispatchEvent(doEventOnElement(el, "keypress"));
        el.dispatchEvent(doEventOnElement(el, "keyup"));
        event2.initEvent("input", true, true);
        el.dispatchEvent(event2);
        event1.initEvent("change", true, true);
        el.dispatchEvent(event1);

        el.blur();
        el.value !== elValue && (el.value = elValue);
      });

    // build out the page details object. this is the final result
    var pageDetails = {
      documentUUID: oneShotId,
      title: theDoc.title,
      url: theView.location.href,
      documentUrl: theDoc.location.href,
      forms: (function (forms) {
        var formObj: any = {};
        forms.forEach(function (f: any) {
          formObj[f.opid] = f;
        });
        return formObj;
      })(theForms),
      fields: theFields,
      collectedTimestamp: new Date().getTime(),
    };

    // get proper page title. maybe they are using the special meta tag?
    // START MODIFICATION
    var theTitle = queryDoc(theDoc, theDoc, function (node) {
      return node.hasAttribute("data-onepassword-title");
    }) as any;
    // END MODIFICATION
    if (theTitle && theTitle.dataset[DISPLAY_TITLE_ATTRIBUE]) {
      pageDetails.displayTitle = theTitle.dataset.onepasswordTitle;
    }

    return pageDetails;
  }

  document.elementForOPID = getElementForOPID;

  /**
   * Do the event on the element.
   * @param {HTMLElement} kedol The element to do the event on
   * @param {string} fonor The event name
   * @returns
   */
  function doEventOnElement(kedol: any, fonor: string) {
    var quebo;
    isFirefox
      ? ((quebo = document.createEvent("KeyboardEvent")),
        quebo.initKeyEvent(fonor, true, false, null, false, false, false, false, 0, 0))
      : ((quebo = kedol.ownerDocument.createEvent("Events")),
        quebo.initEvent(fonor, true, false),
        (quebo.charCode = 0),
        (quebo.keyCode = 0),
        (quebo.which = 0),
        (quebo.srcElement = kedol),
        (quebo.target = kedol));
    return quebo;
  }

  /**
   * Clean up the string `s` to remove non-printable characters and whitespace.
   * @param {string} s
   * @returns {string} Clean text
   */
  function cleanText(s: string): string {
    var sVal = null;
    s &&
      ((sVal = s.replace(/^\\s+|\\s+$|\\r?\\n.*$/gm, "")), (sVal = 0 < sVal.length ? sVal : null));
    return sVal;
  }

  /**
   * If `el` is a text node, add the node's text to `arr`.
   * If `el` is an element node, add the element's `textContent or `innerText` to `arr`.
   * @param {string[]} arr An array of `textContent` or `innerText` values
   * @param {HTMLElement} el The element to push to the array
   */
  function checkNodeType(arr: string[], el: HTMLElement) {
    var theText = "";
    3 === el.nodeType
      ? (theText = el.nodeValue)
      : 1 === el.nodeType && (theText = el.textContent || el.innerText);
    (theText = cleanText(theText)) && arr.push(theText);
  }

  /**
   * Check if `el` is a type that indicates the transition to a new section of the page.
   * If so, this indicates that we should not use `el` or its children for getting autofill context for the previous element.
   * @param {HTMLElement} el The element to check
   * @returns {boolean} Returns `true` if `el` is an HTML element from a known set and `false` otherwise
   */
  function isKnownTag(el: any) {
    if (el && void 0 !== el) {
      var tags = "select option input form textarea button table iframe body head script".split(
        " "
      );

      if (el) {
        var elTag = el ? (el.tagName || "").toLowerCase() : "";
        return tags.constructor == Array ? 0 <= tags.indexOf(elTag) : elTag === tags;
      } else {
        return false;
      }
    } else {
      return true;
    }
  }

  /**
   * Recursively gather all of the text values from the elements preceding `el` in the DOM
   * @param {HTMLElement} el
   * @param {string[]} arr An array of `textContent` or `innerText` values
   * @param {number} steps The number of steps to take up the DOM tree
   */
  function shiftForLeftLabel(el: any, arr: string[], steps: number) {
    var sib;
    for (steps || (steps = 0); el && el.previousSibling; ) {
      el = el.previousSibling;
      if (isKnownTag(el)) {
        return;
      }

      checkNodeType(arr, el);
    }
    if (el && 0 === arr.length) {
      for (sib = null; !sib; ) {
        el = el.parentElement || el.parentNode;
        if (!el) {
          return;
        }
        for (sib = el.previousSibling; sib && !isKnownTag(sib) && sib.lastChild; ) {
          sib = sib.lastChild;
        }
      }

      // base case and recurse
      isKnownTag(sib) ||
        (checkNodeType(arr, sib), 0 === arr.length && shiftForLeftLabel(sib, arr, steps + 1));
    }
  }

  /**
   * Determine if the element is visible.
   * Visible is define as not having `display: none` or `visibility: hidden`.
   * @param {HTMLElement} el
   * @returns {boolean} Returns `true` if the element is visible and `false` otherwise
   */
  function isElementVisible(el: any) {
    var theEl = el;
    // Get the top level document
    el = (el = el.ownerDocument) ? el.defaultView : {};

    // walk the dom tree until we reach the top
    for (var elStyle; theEl && theEl !== document; ) {
      // Calculate the style of the element
      // START MODIFICATION
      elStyle =
        el.getComputedStyle && theEl instanceof Element
          ? el.getComputedStyle(theEl, null)
          : theEl.style;
      // END MODIFICATION

      // If there's no computed style at all, we're done, as we know that it's not hidden
      if (!elStyle) {
        return true;
      }

      // If the element's computed style includes `display: none` or `visibility: hidden`, we know it's hidden
      if ("none" === elStyle.display || "hidden" == elStyle.visibility) {
        return false;
      }

      // At this point, we aren't sure if the element is hidden or not, so we need to keep walking up the tree
      theEl = theEl.parentNode;
    }

    return theEl === document;
  }

  /**
   * Determine if the element is "viewable" on the screen.
   * "Viewable" is defined as being visible in the DOM and being within the confines of the viewport.
   * @param {HTMLElement} el
   * @returns {boolean} Returns `true` if the element is viewable and `false` otherwise
   */
  function isElementViewable(el: HTMLInputElement) {
    var theDoc = el.ownerDocument.documentElement,
      rect = el.getBoundingClientRect(), // getBoundingClientRect is relative to the viewport
      docScrollWidth = theDoc.scrollWidth, // scrollWidth is the width of the document including any overflow
      docScrollHeight = theDoc.scrollHeight, // scrollHeight is the height of the document including any overflow
      leftOffset = rect.left - theDoc.clientLeft, // How far from the left of the viewport is the element, minus the left border width?
      topOffset = rect.top - theDoc.clientTop, // How far from the top of the viewport is the element, minus the top border width?
      theRect;

    if (!isElementVisible(el) || !el.offsetParent || 10 > el.clientWidth || 10 > el.clientHeight) {
      return false;
    }

    var rects = el.getClientRects();
    if (0 === rects.length) {
      return false;
    }

    // If any of the rects have a left side that is further right than the document width or a right side that is
    // further left than the origin (i.e. is negative), we consider the element to be not viewable
    for (var i = 0; i < rects.length; i++) {
      if (((theRect = rects[i]), theRect.left > docScrollWidth || 0 > theRect.right)) {
        return false;
      }
    }

    // If the element is further left than the document width, or further down than the document height, we know that it's not viewable
    if (
      0 > leftOffset ||
      leftOffset > docScrollWidth ||
      0 > topOffset ||
      topOffset > docScrollHeight
    ) {
      return false;
    }

    // Our next check is going to get the center point of the element, and then use elementFromPoint to see if the element
    // is actually returned from that point. If it is, we know that it's viewable. If it isn't, we know that it's not viewable.
    // If the right side of the bounding rectangle is outside the viewport, the x coordinate of the center point is the window width (minus offset) divided by 2.
    // If the right side of the bounding rectangle is inside the viewport, the x coordinate of the center point is the width of the bounding rectangle divided by 2.
    // If the bottom of the bounding rectangle is outside the viewport, the y coordinate of the center point is the window height (minus offset) divided by 2.
    // If the bottom side of the bounding rectangle is inside the viewport, the y coordinate of the center point is the height of the bounding rectangle divided by
    // We then use elementFromPoint to find the element at that point.
    for (
      var pointEl = el.ownerDocument.elementFromPoint(
        leftOffset +
          (rect.right > window.innerWidth ? (window.innerWidth - leftOffset) / 2 : rect.width / 2),
        topOffset +
          (rect.bottom > window.innerHeight
            ? (window.innerHeight - topOffset) / 2
            : rect.height / 2)
      );
      pointEl && pointEl !== el && pointEl !== document;

    ) {
      // If the element we found is a label, and the element we're checking has labels
      if (
        pointEl.tagName &&
        "string" === typeof pointEl.tagName &&
        "label" === pointEl.tagName.toLowerCase() &&
        el.labels &&
        0 < el.labels.length
      ) {
        // Return true if the element we found is one of the labels for the element we're checking.
        // This means that the element we're looking for is considered viewable
        return 0 <= Array.prototype.slice.call(el.labels).indexOf(pointEl);
      }

      // Walk up the DOM tree to check the parent element
      pointEl = pointEl.parentNode as Element;
    }

    // If the for loop exited because we found the element we're looking for, return true, as it's viewable
    // If the element that we found isn't the element we're looking for, it means the element we're looking for is not viewable
    return pointEl === el;
  }

  /**
   * Retrieve the element from the document with the specified `opid` property
   * @param {number} opId
   * @returns {HTMLElement} The element with the specified `opiId`, or `null` if no such element exists
   */
  function getElementForOPID(opId: number) {
    var theEl;
    if (void 0 === opId || null === opId) {
      return null;
    }

    try {
      var formEls = Array.prototype.slice.call(getFormElements(document));
      var filteredFormEls = formEls.filter(function (el) {
        return el.opid == opId;
      });

      if (0 < filteredFormEls.length) {
        (theEl = filteredFormEls[0]),
          1 < filteredFormEls.length &&
            console.warn("More than one element found with opid " + opId);
      } else {
        var theIndex = parseInt(opId.split("__")[1], 10);
        isNaN(theIndex) || (theEl = formEls[theIndex]);
      }
    } catch (e) {
      console.error("An unexpected error occurred: " + e);
    } finally {
      return theEl;
    }
  }

  var ignoredInputTypes = {
    hidden: true,
    submit: true,
    reset: true,
    button: true,
    image: true,
    file: true,
  };

  /*
   * inputEl MUST BE an instanceof HTMLInputElement, else inputEl.type.toLowerCase will throw an error
   */
  function isRelevantInputField(inputEl: HTMLInputElement) {
    if (inputEl.hasAttribute("data-bwignore")) {
      return false;
    }

    const isIgnoredInputType = ignoredInputTypes.hasOwnProperty(inputEl.type.toLowerCase());

    return !isIgnoredInputType;
  }

  /**
   * Query `theDoc` for form elements that we can use for autofill, ranked by importance and limited by `limit`
   * @param {Document} theDoc The Document to query
   * @param {number} limit The maximum number of elements to return
   * @returns An array of HTMLElements
   */
  function getFormElements(theDoc: Document, limit: number) {
    // START MODIFICATION

    var els = queryDocAll(theDoc, theDoc.body, function (el) {
      switch (el.nodeName) {
        case "SELECT":
          return true;
        case "SPAN":
          return el.hasAttribute("data-bwautofill");
        case "INPUT":
          return isRelevantInputField(el);
        default:
          return false;
      }
    });

    if (!limit || els.length <= limit) {
      return els;
    }

    // non-checkboxes/radios have higher priority
    var returnEls = [];
    var unimportantEls = [];
    for (var i = 0; i < els.length; i++) {
      if (returnEls.length >= limit) {
        break;
      }

      var el = els[i];
      var type = el.type ? el.type.toLowerCase() : el.type;
      if (type === "checkbox" || type === "radio") {
        unimportantEls.push(el);
      } else {
        returnEls.push(el);
      }
    }

    var unimportantElsToAdd = limit - returnEls.length;
    if (unimportantElsToAdd > 0) {
      returnEls = returnEls.concat(unimportantEls.slice(0, unimportantElsToAdd));
    }

    return returnEls;
  }
  // END MODIFICATION

  /**
   * Focus the element `el` and optionally restore its original value
   * @param {HTMLElement} el
   * @param {boolean} setVal Set the value of the element to its original value
   */
  function focusElement(el: any, setVal: boolean) {
    if (setVal) {
      var initialValue = el.value;
      el.focus();

      if (el.value !== initialValue) {
        el.value = initialValue;
      }
    } else {
      el.focus();
    }
  }

  return JSON.stringify(getPageDetails(document, "oneshotUUID"));
}

function fill(document: any, fillScript: AutofillScript): string {
  var markTheFilling = true,
    animateTheFilling = true;

  function queryPasswordInputs() {
    return queryDocAll(document, document.body, function (el) {
      return el.nodeName === "INPUT" && el.type.toLowerCase() === "password";
    });
  }

  // Check if URL is not secure when the original saved one was
  function urlNotSecure(savedURLs) {
    var passwordInputs = null;
    if (!savedURLs) {
      return false;
    }

    return savedURLs.some((url) => url?.indexOf("https://") === 0) &&
      "http:" === document.location.protocol &&
      ((passwordInputs = queryPasswordInputs()),
      0 < passwordInputs.length &&
        ((confirmResult = confirm(
          "Warning: This is an unsecured HTTP page, and any information you submit can potentially be seen and changed by others. This Login was originally saved on a secure (HTTPS) page.\n\nDo you still wish to fill this login?"
        )),
        0 == confirmResult))
      ? true
      : false;
  }

  // Detect if within an iframe, and the iframe is sandboxed
  function isSandboxed() {
    // self.origin is 'null' if inside a frame with sandboxed csp or iframe tag
    return self.origin == null || self.origin === "null";
  }

  function doFill(fillScript) {
    var fillScriptOps,
      theOpIds = [],
      fillScriptProperties = fillScript.properties,
      operationDelayMs = 1,
      doOperation,
      operationsToDo = [];

    fillScriptProperties &&
      fillScriptProperties.delay_between_operations &&
      (operationDelayMs = fillScriptProperties.delay_between_operations);

    if (isSandboxed() || urlNotSecure(fillScript.savedUrls)) {
      return;
    }

    if (fillScript.untrustedIframe) {
      // confirm() is blocked by sandboxed iframes, but we don't want to fill sandboxed iframes anyway.
      // If this occurs, confirm() returns false without displaying the dialog box, and autofill will be aborted.
      // The browser may print a message to the console, but this is not a standard error that we can handle.
      var acceptedIframeWarning = confirm(
        "The form is hosted by a different domain than the URI " +
          "of your saved login. Choose OK to auto-fill anyway, or Cancel to stop. " +
          "To prevent this warning in the future, save this URI, " +
          window.location.hostname +
          ", to your login."
      );
      if (!acceptedIframeWarning) {
        return;
      }
    }

    doOperation = function (ops, theOperation) {
      var op = ops[0];
      if (void 0 === op) {
        theOperation();
      } else {
        // should we delay?
        if ("delay" === op.operation || "delay" === op[0]) {
          operationDelayMs = op.parameters ? op.parameters[0] : op[1];
        } else {
          if ((op = normalizeOp(op))) {
            for (var opIndex = 0; opIndex < op.length; opIndex++) {
              -1 === operationsToDo.indexOf(op[opIndex]) && operationsToDo.push(op[opIndex]);
            }
          }
          theOpIds = theOpIds.concat(
            operationsToDo.map(function (operationToDo) {
              return operationToDo && operationToDo.hasOwnProperty("opid")
                ? operationToDo.opid
                : null;
            })
          );
        }
        setTimeout(function () {
          doOperation(ops.slice(1), theOperation);
        }, operationDelayMs);
      }
    };

    if ((fillScriptOps = fillScript.options)) {
      fillScriptOps.hasOwnProperty("animate") && (animateTheFilling = fillScriptOps.animate),
        fillScriptOps.hasOwnProperty("markFilling") && (markTheFilling = fillScriptOps.markFilling);
    }

    // don't mark a password filling
    fillScript.itemType && "fillPassword" === fillScript.itemType && (markTheFilling = false);

    if (!fillScript.hasOwnProperty("script")) {
      return;
    }

    // custom fill script

    fillScriptOps = fillScript.script;
    doOperation(fillScriptOps, function () {
      // Done now
      // Do we have anything to autosubmit?
      if (fillScript.hasOwnProperty("autosubmit") && "function" == typeof autosubmit) {
        (fillScript.itemType && "fillLogin" !== fillScript.itemType) ||
          (0 < operationsToDo.length
            ? setTimeout(function () {
                autosubmit(
                  fillScript.autosubmit,
                  fillScriptProperties.allow_clicky_autosubmit,
                  operationsToDo
                );
              }, AUTOSUBMIT_DELAY)
            : DEBUG_AUTOSUBMIT &&
              console.log(
                "[AUTOSUBMIT] Not attempting to submit since no fields were filled: ",
                operationsToDo
              ));
      }

      // handle protectedGlobalPage
      if ("object" == typeof protectedGlobalPage) {
        protectedGlobalPage.b(
          "fillItemResults",
          {
            documentUUID: documentUUID,
            fillContextIdentifier: fillScript.fillContextIdentifier,
            usedOpids: theOpIds,
          },
          function () {
            fillingItemType = null;
          }
        );
      }
    });
  }

  // fill for reference
  var thisFill = {
    fill_by_opid: doFillByOpId,
    fill_by_query: doFillByQuery,
    click_on_opid: doClickByOpId,
    click_on_query: doClickByQuery,
    touch_all_fields: touchAllFields,
    simple_set_value_by_query: doSimpleSetByQuery,
    focus_by_opid: doFocusByOpId,
    delay: null,
  };

  // normalize the op versus the reference
  function normalizeOp(op) {
    var thisOperation;
    if (op.hasOwnProperty("operation") && op.hasOwnProperty("parameters")) {
      (thisOperation = op.operation), (op = op.parameters);
    } else {
      if ("[object Array]" === Object.prototype.toString.call(op)) {
        (thisOperation = op[0]), (op = op.splice(1));
      } else {
        return null;
      }
    }
    return thisFill.hasOwnProperty(thisOperation) ? thisFill[thisOperation].apply(this, op) : null;
  }

  // do a fill by opid operation
  function doFillByOpId(opId, op) {
    var el = getElementByOpId(opId);
    return el ? (fillTheElement(el, op), [el]) : null;
  }

  /**
   * Find all elements matching `query` and fill them using the value `op` from the fill script
   * @param {string} query
   * @param {string} op
   * @returns {HTMLElement}
   */
  function doFillByQuery(query, op) {
    var elements = selectAllFromDoc(query);
    return Array.prototype.map.call(
      Array.prototype.slice.call(elements),
      function (el) {
        fillTheElement(el, op);
        return el;
      },
      this
    );
  }

  /**
   * Assign `valueToSet` to all elements in the DOM that match `query`.
   * @param {string} query
   * @param {string} valueToSet
   * @returns {Array} Array of elements that were set.
   */
  function doSimpleSetByQuery(query, valueToSet) {
    var elements = selectAllFromDoc(query),
      arr = [];
    Array.prototype.forEach.call(Array.prototype.slice.call(elements), function (el) {
      el.disabled ||
        el.a ||
        el.readOnly ||
        void 0 === el.value ||
        ((el.value = valueToSet), arr.push(el));
    });
    return arr;
  }

  /**
   * Do a a click and focus on the element with the given `opId`.
   * @param {number} opId
   * @returns
   */
  function doFocusByOpId(opId) {
    var el = getElementByOpId(opId);
    if (el) {
      "function" === typeof el.click && el.click(),
        "function" === typeof el.focus && doFocusElement(el, true);
    }

    return null;
  }

  /**
   * Do a click on the element with the given `opId`.
   * @param {number} opId
   * @returns
   */
  function doClickByOpId(opId) {
    var el = getElementByOpId(opId);
    return el ? (clickElement(el) ? [el] : null) : null;
  }

  /**
   * Do a `click` and `focus` on all elements that match the query.
   * @param {string} query
   * @returns
   */
  function doClickByQuery(query) {
    query = selectAllFromDoc(query);
    return Array.prototype.map.call(
      Array.prototype.slice.call(query),
      function (el) {
        clickElement(el);
        "function" === typeof el.click && el.click();
        "function" === typeof el.focus && doFocusElement(el, true);
        return [el];
      },
      this
    );
  }

  var checkRadioTrueOps = {
      true: true,
      y: true,
      1: true,
      yes: true,
      "✓": true,
    },
    styleTimeout = 200;

  /**
   * Fll an element `el` using the value `op` from the fill script
   * @param {HTMLElement} el
   * @param {string} op
   */
  function fillTheElement(el, op) {
    var shouldCheck;
    if (el && null !== op && void 0 !== op && !(el.disabled || el.a || el.readOnly)) {
      switch (
        (markTheFilling && el.form && !el.form.opfilled && (el.form.opfilled = true),
        el.type ? el.type.toLowerCase() : null)
      ) {
        case "checkbox":
          shouldCheck =
            op &&
            1 <= op.length &&
            checkRadioTrueOps.hasOwnProperty(op.toLowerCase()) &&
            true === checkRadioTrueOps[op.toLowerCase()];
          el.checked === shouldCheck ||
            doAllFillOperations(el, function (theEl) {
              theEl.checked = shouldCheck;
            });
          break;
        case "radio":
          true === checkRadioTrueOps[op.toLowerCase()] && el.click();
          break;
        default:
          el.value == op ||
            doAllFillOperations(el, function (theEl) {
              // START MODIFICATION
              if (!theEl.type && theEl.tagName.toLowerCase() === "span") {
                theEl.innerText = op;
                return;
              }
              // END MODIFICATION
              theEl.value = op;
            });
      }
    }
  }

  /**
   * Do all the fill operations needed on the element `el`.
   * @param {HTMLElement} el
   * @param {*} afterValSetFunc The function to perform after the operations are complete.
   */
  function doAllFillOperations(el, afterValSetFunc) {
    setValueForElement(el);
    afterValSetFunc(el);
    setValueForElementByEvent(el);

    // START MODIFICATION
    if (canSeeElementToStyle(el)) {
      el.classList.add("com-bitwarden-browser-animated-fill");
      setTimeout(function () {
        if (el) {
          el.classList.remove("com-bitwarden-browser-animated-fill");
        }
      }, styleTimeout);
    }
    // END MODIFICATION
  }

  document.elementForOPID = getElementByOpId;

  /**
   * Normalize the event based on API support
   * @param {HTMLElement} el
   * @param {string} eventName
   * @returns {Event} A normalized event
   */
  function normalizeEvent(el, eventName) {
    var ev;
    if ("KeyboardEvent" in window) {
      ev = new window.KeyboardEvent(eventName, {
        bubbles: true,
        cancelable: false,
      });
    } else {
      ev = el.ownerDocument.createEvent("Events");
      ev.initEvent(eventName, true, false);
      ev.charCode = 0;
      ev.keyCode = 0;
      ev.which = 0;
      ev.srcElement = el;
      ev.target = el;
    }

    return ev;
  }

  /**
   * Simulate the entry of a value into an element.
   * Clicks the element, focuses it, and then fires a keydown, keypress, and keyup event.
   * @param {HTMLElement} el
   */
  function setValueForElement(el) {
    var valueToSet = el.value;
    clickElement(el);
    doFocusElement(el, false);
    el.dispatchEvent(normalizeEvent(el, "keydown"));
    el.dispatchEvent(normalizeEvent(el, "keypress"));
    el.dispatchEvent(normalizeEvent(el, "keyup"));
    el.value !== valueToSet && (el.value = valueToSet);
  }

  /**
   * Simulate the entry of a value into an element by using events.
   * Dispatches a keydown, keypress, and keyup event, then fires the `input` and `change` events before removing focus.
   * @param {HTMLElement} el
   */
  function setValueForElementByEvent(el) {
    var valueToSet = el.value,
      ev1 = el.ownerDocument.createEvent("HTMLEvents"),
      ev2 = el.ownerDocument.createEvent("HTMLEvents");

    el.dispatchEvent(normalizeEvent(el, "keydown"));
    el.dispatchEvent(normalizeEvent(el, "keypress"));
    el.dispatchEvent(normalizeEvent(el, "keyup"));
    ev2.initEvent("input", true, true);
    el.dispatchEvent(ev2);
    ev1.initEvent("change", true, true);
    el.dispatchEvent(ev1);
    el.blur();
    el.value !== valueToSet && (el.value = valueToSet);
  }

  /**
   * Click on an element `el`
   * @param {HTMLElement} el
   * @returns {boolean} Returns true if the element was clicked and false if it was not able to be clicked
   */
  function clickElement(el) {
    if (!el || (el && "function" !== typeof el.click)) {
      return false;
    }
    el.click();
    return true;
  }

  /**
   * Get all the elements on the DOM that are likely to be a password field
   * @returns {Array} Array of elements
   */
  function getAllFields() {
    var r = RegExp(
      "((\\\\b|_|-)pin(\\\\b|_|-)|password|passwort|kennwort|passe|contraseña|senha|密码|adgangskode|hasło|wachtwoord)",
      "i"
    );
    return queryDocAll(document, document.body, function (el) {
      return (
        el.nodeName === "INPUT" && el.type.toLowerCase() === "text" && el.value && r.test(el.value)
      );
    });
  }

  /**
   * Touch all the fields
   */
  function touchAllFields() {
    getAllFields().forEach(function (el) {
      setValueForElement(el);
      el.click && el.click();
      setValueForElementByEvent(el);
    });
  }

  /**
   * Determine if we can apply styling to `el` to indicate that it was filled.
   * @param {HTMLElement} el
   * @returns {boolean} Returns true if we can see the element to apply styling.
   */
  function canSeeElementToStyle(el) {
    var currentEl;
    if ((currentEl = animateTheFilling)) {
      a: {
        currentEl = el;
        for (
          var owner = el.ownerDocument, owner = owner ? owner.defaultView : {}, theStyle;
          currentEl && currentEl !== document;

        ) {
          // START MODIFICATION
          theStyle =
            owner.getComputedStyle && currentEl instanceof Element
              ? owner.getComputedStyle(currentEl, null)
              : currentEl.style;
          // END MODIFICATION
          if (!theStyle) {
            currentEl = true;
            break a;
          }
          if ("none" === theStyle.display || "hidden" == theStyle.visibility) {
            currentEl = false;
            break a;
          }
          currentEl = currentEl.parentNode;
        }
        currentEl = currentEl === document;
      }
    }
    // START MODIFICATION
    if (el && !el.type && el.tagName.toLowerCase() === "span") {
      return true;
    }
    // END MODIFICATION
    return currentEl
      ? -1 !== "email text password number tel url".split(" ").indexOf(el.type || "")
      : false;
  }

  /**
   * Find the element for the given `opid`.
   * @param {number} theOpId
   * @returns {HTMLElement} The element for the given `opid`, or `null` if not found.
   */
  function getElementByOpId(theOpId) {
    var theElement;
    if (void 0 === theOpId || null === theOpId) {
      return null;
    }
    try {
      // START MODIFICATION
      var filteredElements = queryDocAll(document, document.body, function (el) {
        switch (el.nodeName) {
          case "INPUT":
          case "SELECT":
          case "BUTTON":
            return el.opid === theOpId;
          case "SPAN":
            return el.hasAttribute("data-bwautofill") && el.opid === theOpId;
        }

        return false;
      });
      // END MODIFICATION
      if (0 < filteredElements.length) {
        (theElement = filteredElements[0]),
          1 < filteredElements.length &&
            console.warn("More than one element found with opid " + theOpId);
      } else {
        var elIndex = parseInt(theOpId.split("__")[1], 10);
        isNaN(elIndex) || (theElement = elements[elIndex]);
      }
    } catch (e) {
      console.error("An unexpected error occurred: " + e);
    } finally {
      return theElement;
    }
  }

  /**
   * Helper for doc.querySelectorAll
   * @param {string} theSelector
   * @returns
   */
  function selectAllFromDoc(theSelector) {
    // START MODIFICATION
    return queryDocAll(document, document, function (node) {
      return node.matches(theSelector);
    });
    // END MODIFICATION
  }

  /**
   * Focus an element and optionally re-set its value after focusing
   * @param {HTMLElement} el
   * @param {boolean} setValue Re-set the value after focusing
   */
  function doFocusElement(el, setValue) {
    if (setValue) {
      var existingValue = el.value;
      el.focus();
      el.value !== existingValue && (el.value = existingValue);
    } else {
      el.focus();
    }
  }

  doFill(fillScript);

  return JSON.stringify({
    success: true,
  });
}

/*
  End 1Password Extension
  */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.command === "collectPageDetails") {
    var pageDetails = collect(document);
    var pageDetailsObj: AutofillPageDetails = JSON.parse(pageDetails);
    chrome.runtime.sendMessage({
      command: "collectPageDetailsResponse",
      tab: msg.tab,
      details: pageDetailsObj,
      sender: msg.sender,
    });
    sendResponse();
    return true;
  } else if (msg.command === "fillForm") {
    fill(document, msg.fillScript);
    sendResponse();
    return true;
  } else if (msg.command === "collectPageDetailsImmediately") {
    var pageDetails = collect(document);
    var pageDetailsObj: AutofillPageDetails = JSON.parse(pageDetails);
    sendResponse(pageDetailsObj);
    return true;
  }
});