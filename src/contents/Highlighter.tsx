import React, { useState, useEffect } from 'react';
import { getMainContent, splitContent } from '~util/extractContent'
import { textNodesUnderElem, findTextSlow, findTextFast, highlightText, resetHighlights, textNodesNotUnderHighlight, surroundTextNode } from '~util/DOM'
import { computeEmbeddingsLocal } from '~util/embedding'
import { sendToBackground } from "@plasmohq/messaging"
import { useStorage } from "@plasmohq/storage/hook";
import { useSessionStorage as _useSessionStorage, arraysAreEqual } from '~util/misc'
import { useActiveState } from '~util/activeStatus'
import HighlightStyler from '~components/HighlightStyler';
import { useGlobalStorage } from '~util/useGlobalStorage';
import Scroller from '~components/Scroller';
import TestsetHelper from '~components/TestsetHelper';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';

const DEV = process.env.NODE_ENV == "development";
const useSessionStorage = DEV && process.env.PLASMO_PUBLIC_STORAGE == "persistent" ? useStorage : _useSessionStorage;
type classEmbeddingType = {allclasses: string[], classStore: any};


const Highlighter = () => {
    const [ tabId, setTabId ] = useState(null);
    const [ [savedUrl], [,setTopicCounts], [,setScores], [,setStatusEmbeddings], [,setStatusHighlight], [classEmbeddings, setClassEmbeddings], [setGlobalStorage, connected] ] = useGlobalStorage(tabId, "url", "topicCounts", "classifierScores", "status_embedding", "status_highlight", "classEmbeddings");
    const [ url, isActive ] = useActiveState(window.location);
    const [ pageEmbeddings, setPageEmbeddings ] = useState({});
    const [ classifierData ] = useSessionStorage("classifierData:"+tabId, {});
    const [ retrievalQuery ] = useSessionStorage("retrievalQuery:"+tabId, null);

    // -------- //
    // settings //
    // -------- //
    const [ verbose ] = useStorage("verbose", false);
    const [ textclassifier ] = useStorage('textclassifier')
    const [ textretrieval ] = useStorage('textretrieval')
    const [ textretrieval_k ] = useStorage('textretrieval_k')
    const [ alwayshighlighteps ] = useStorage("alwayshighlighteps");
    const [ minimalhighlighteps ] = useStorage("minimalhighlighteps");
    const [ decisioneps ] = useStorage("decisioneps");


    // ------- //
    // effects //
    // ------- //

    // init (make sure tabId is known, needed for messaging with other parts of this application)
    useEffect(() => {
      if (!isActive) return;

      async function init() {
        const tabId = await chrome.runtime.sendMessage("get_tabid")
        setTabId(tabId);
      }
      init();
    }, [isActive])

        
    // start directly by getting page embeddings
    useEffect(() => {
      if (!isActive || !tabId) return;

      // reset only if we have a new url
      if (url == savedUrl) return;

      // data
      setGlobalStorage({
        message: "",
        status_embedding: ["checking", 0],
        title: document.title,
        url: url,
        _tabId: tabId
      })

      // start directly by getting page embeddings
      async function init() {
        const mode = "sentences";
        const newEmbeddings = await getPageEmbeddings(mode, setStatusEmbeddings);
        setPageEmbeddings(old => ({ ...old, [mode]: newEmbeddings }));
      }
      init();
    }, [isActive, tabId])


    // on every classifier change, recompute highlights
    useEffect(() => {
      resetHighlights()
      if(!tabId || !isActive || !connected || !classifierData.thought) return;

      const applyHighlight = () => {
        try {
          if (textclassifier) {
            highlightUsingClasses()
          }
          if (textretrieval) {
            //highlightUsingRetrieval(retrievalQuery)
          }
        } catch (error) {
          console.error('Error in applyHighlight:', error);
        }
      }
      applyHighlight()
    }, [connected, classifierData, isActive, textclassifier, textretrieval, retrievalQuery])


    // --------- //
    // functions //
    // --------- //

    // ensure page embeddings exist
    const getPageEmbeddings = async (mode = "sentences", onStatus = (status: [string, Number, string?]) => {}) => {

      // use cache if already computed
      if (pageEmbeddings[mode]) return pageEmbeddings[mode];

      // if not in cache, check if database has embeddings
      const exists = await sendToBackground({ name: "embedding_exists", body: { collectionName: url } })
      if (!exists)
        onStatus(["computing", 0])
      else
        onStatus(["computing", 0, "found database"])

      // extract main content & generate splits
      const mainEl = getMainContent(true);
      const [splits, metadata] = splitContent(mainEl.textContent, mode, url as string)

      // retrieve embedding (either all at once or batch-wise)
      let splitEmbeddings = [];
      if (exists)
        splitEmbeddings = await sendToBackground({ name: "embedding_compute", body: { collectionName: url, splits: splits, metadata: metadata } })
      else {
        const batchSize = 64;
        for(let i = 0; i < splits.length; i+= batchSize) {
          const splitEmbeddingsBatch = await sendToBackground({ name: "embedding_compute", body: { collectionName: url, splits: splits.slice(i, i+batchSize), metadata: metadata.slice(i, i+batchSize) } })
          splitEmbeddings = splitEmbeddings.concat(splitEmbeddingsBatch);
          onStatus(["computing", Math.floor(i / splits.length * 100)])
        }
      }
      const _pageEmbeddings = { [mode]: { splits: splits, metadata: metadata, embeddings: splitEmbeddings } }
      onStatus(["loaded", 100])
      return _pageEmbeddings;
    }


    const highlightUsingClasses = async (mode = "sentences") => {
      const classes_pos = classifierData.classes_pos;
      const classes_neg = classifierData.classes_neg;
      if (!classes_pos || !classes_neg)
        return;

      setStatusHighlight(["checking", 0]);
      const allclasses = [...classes_pos, ...classes_neg]
      const class2Id = Object.fromEntries(allclasses.map((c, i) => [c, i]))

      // ensure we have embedded the page contents
      const pageEmbeddings = await getPageEmbeddings(mode)
      const splits = pageEmbeddings[mode].splits;
      const splitEmbeddings = pageEmbeddings[mode].embeddings;

      // use cached / compute embeddings of classes
      let classStore, embeddings;
      if (classEmbeddings && (classEmbeddings as classEmbeddingType)?.allclasses && arraysAreEqual((classEmbeddings as classEmbeddingType).allclasses, allclasses)) {
        setStatusHighlight(["checking", 0, "found cache"]);
        classStore = new MemoryVectorStore(classEmbeddings.embeddings);
        classStore.memoryVectors = Object.values(classEmbeddings.embeddings);
      } else {
        setStatusHighlight(["checking", 0, "embedding classes"]);
        [ classStore, embeddings ] = await computeEmbeddingsLocal(allclasses, []);
        setClassEmbeddings({allclasses, embeddings})
      }

      // get all text nodes
      const textNodes = textNodesUnderElem(document.body);
      let currentTextNodes = textNodes;
      const toHighlight = [];

      // mark sentences based on similarity
      let scores_diffs = [];
      let scores_plus = [];
      for (const i in splits) {
        const split = splits[i];

        // using precomputed embeddings
        const embedding = splitEmbeddings[split];
        const closest = await classStore.similaritySearchVectorWithScore(embedding, allclasses.length);

        const score_plus = classes_pos ? closest.filter((c) => classes_pos.includes(c[0].pageContent)).reduce((a, c) => Math.max(a, c[1]), 0) : 0
        const score_minus = classes_neg ? closest.filter((c) => classes_neg.includes(c[0].pageContent)).reduce((a, c) => Math.max(a, c[1]), 0) : 0

        scores_plus.push(score_plus);
        scores_diffs.push(score_plus - score_minus);

        let highlight = false;

        // always highlight if similarity is above given value
        if (alwayshighlighteps > 0 && score_plus > alwayshighlighteps) {
          if (verbose) console.log("mark", split, score_plus, score_minus)
          highlight = true;
        }

        // ignore anything that is not distinguishable
        //if (score_plus < MIN_CLASS_EPS || Math.abs(score_plus - score_minus) < EPS) {
        else if (!highlight && (decisioneps > 0 && Math.abs(score_plus - score_minus) < decisioneps || minimalhighlighteps > 0 && score_plus < minimalhighlighteps)) {
          if (verbose) console.log("skipping", split, score_plus, score_minus)
        }

        // apply color if is first class
        else if (score_plus > score_minus) {
          if (verbose) console.log("mark", split, score_plus, score_minus)
          highlight = true;
        }
        
        else {
          if (verbose) console.log("reject", split, score_plus, score_minus)
        }

        // remember to mark split for highlighting later streamlined
        if (true || highlight) {
          let [texts, from_node_pos, to_node_pos] = findTextFast(currentTextNodes, split);
          if (texts.length == 0) {
            [texts, from_node_pos, to_node_pos] = findTextSlow(currentTextNodes, split);
            if (texts.length == 0) {
              console.log("ERROR: text not found:", split)
            }
          }
          if (to_node_pos >= 0) {
            currentTextNodes = currentTextNodes.slice(to_node_pos-1);
            const closestClass = closest[0][0].pageContent;
            const closestScore = closest[0][1]
            const otherclassmod = class2Id[closestClass] < classifierData.classes_pos.length ? -1 : 1;
            const otherclassmatches = closest.filter(([doc, score]) => class2Id[doc.pageContent] * otherclassmod < classifierData.classes_pos.length * otherclassmod)
            const otherClass = otherclassmatches[0][0].pageContent;
            const otherClassScore = otherclassmatches[0][1];
            toHighlight.push({texts, from_node_pos, to_node_pos, closestClass, closestScore, otherClass, otherClassScore, otherclassmod})
          }
        }

        setStatusHighlight(["computing", 100 * Number(i) / splits.length]);
      }

      // streamlined text highlighting
      currentTextNodes = textNodes;
      const topicCounts = Object.fromEntries(allclasses.map((c) => [c, 0]))
      for(let i=0; i<toHighlight.length; i++) {
        const {texts, from_node_pos, to_node_pos, closestClass, closestScore, otherClass, otherClassScore, otherclassmod} = toHighlight[i];
        const nonWhiteTexts = texts.filter(t => t.trim())
        const textNodesSubset = currentTextNodes.slice(from_node_pos, to_node_pos).filter(t => t.textContent.trim());
        const highlightClass = class2Id[closestClass];
        const replacedNodes = highlightText(nonWhiteTexts, textNodesSubset, highlightClass, (span) => {
          span.setAttribute("data-title", `[${otherclassmod < 0 ? "✓" : "✗"}] ${closestScore.toFixed(2)}: ${closestClass} | [${otherclassmod < 0 ? "✗" : "✓"}] ${otherClassScore.toFixed(2)}: ${otherClass}`);
          span.setAttribute("splitid", topicCounts[closestClass])
          if (DEV)
            span.setAttribute("splitid_total", i);
        });
        topicCounts[closestClass] += 1
        currentTextNodes = currentTextNodes.slice(to_node_pos);
        currentTextNodes.unshift(replacedNodes.pop())
      }

      // finally, let's highlight all textnodes that are not highlighted
      const emptyTextNodes = textNodesNotUnderHighlight(document.body);
      emptyTextNodes.forEach(node => surroundTextNode(node, "normaltext"))

      // in DEV mode, we also save the all the data
      if (DEV)
        setGlobalStorage({ DEV_highlighterData: { url, classifierData, splits }});

      setTopicCounts(topicCounts)
      setScores([scores_plus, scores_diffs])
      setStatusHighlight(["loaded", 100]);
    }


    // mark sentences based on retrieval
    /*
    const highlightUsingRetrieval = async (query, mode = "sentences") => {
      if (!query) return;

      // ensure we have embedded the page contents
      const pageEmbeddings = await getPageEmbeddings(mode)
      const splits = pageEmbeddings[mode].splits;
      const metadata = pageEmbeddings[mode].metadata;

      // using precomputed embeddings
      const retrieved_splits = (await sendToBackground({ name: "retrieval", body: {collectionName: url, splits: splits, metadata: metadata, query: query, k: textretrieval_k }}))
      console.log("retrieved", retrieved_splits)

      for (const i in retrieved_splits) {
        const split = retrieved_splits[i][0].pageContent;
        const score = retrieved_splits[i][1]

        // apply color if is first class
        if (verbose) console.log("mark retrieval", split, score)

        // get all text nodes
        const textNodes = textNodesUnderElem(document.body);

        // mark sentence
        const [texts, nodes] = findTextSlow(textNodes, split);
        highlightText(texts, nodes, "retrieval", 1.0);
      }
    }
    */

    return [
      <HighlightStyler key="styler" tabId={tabId}/>,
      <Scroller key="scroller" tabId={tabId}/>,
      DEV ? <TestsetHelper key="testsethelper" tabId={tabId}/> : "",
    ]
};

export default Highlighter;