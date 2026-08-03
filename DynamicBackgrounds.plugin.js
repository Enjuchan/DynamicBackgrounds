/**
 * @name DynamicBackgrounds
 * @author Enju
 * @description Extends Discord themes with background images, slideshow, transitions and ambient effects.
 * @version 3.6.3
 * @source https://github.com/Enjuchan/DynamicBackgrounds/blob/main/DynamicBackgrounds.plugin.js
 * @updateUrl https://raw.githubusercontent.com/Enjuchan/DynamicBackgrounds/main/DynamicBackgrounds.plugin.js
 * @website https://github.com/Enjuchan/DynamicBackgrounds
 */

const { React, Webpack, UI, Webpack: { Filters }, Patcher, DOM, ContextMenu, Data } = BdApi;

/** @type {typeof import("react")} */
const { useState, useEffect, useRef, useCallback, useId, useMemo, createElement: jsx, Fragment } = React;

const DATA_BASE_NAME = 'DynamicBackgrounds';

/* ---- Timing des Stapel-Effekts in der Kategorie-Uebersicht ----
   Der Ablauf ist bewusst GESTAFFELT, damit es wie echtes Durchblaettern
   wirkt: erst wird die oberste Karte angehoben und nach hinten gefuehrt,
   und ERST DANN ruecken die anderen nach. Laufen beide gleichzeitig los,
   ist die zweite Karte schon oben, bevor die erste weg ist - dann sieht es
   aus, als wuerde sie einfach erscheinen. */
const STACK_TRAVEL_MS      = 900;  // Reise der obersten Karte (anheben, hinter den Stapel, einreihen)
const STACK_SHIFT_MS       = 520;  // wie lange die uebrigen Karten zum Nachruecken brauchen
const STACK_SHIFT_DELAY_MS = 350;  // warten, bis die Karte angehoben UND hinter dem Stapel ist
                                   // (der z-index-Wechsel liegt bei 38% von STACK_TRAVEL_MS)

/* Sperre gegen erneutes Ausloesen: so lange, wie die laengste Bewegung dauert. */
const STACK_ANIM_MS = Math.max(STACK_TRAVEL_MS, STACK_SHIFT_MS + STACK_SHIFT_DELAY_MS);

/* ÜBERGÄNGE - laufen einmal beim Bildwechsel, Dauer aus den Einstellungen. */
const transitionTypes = {
  fade:     'Fade',
  slide:    'Slide (horizontal)',
  slideup:  'Slide (from bottom)',
  zoom:     'Zoom in',
  zoomout:  'Zoom out',
  blur:     'Blur',
  spin:     'Spin',
  curtain:  'Curtain',
  wipe:     'Wipe',
  iris:     'Iris'
};

/* DAUEREFFEKTE - liegen permanent auf dem Bild und laufen weiter.
   Frei mit jedem Übergang kombinierbar. */
const ambientTypes = {
  none:      'None',
  kenburns:  'Ken Burns',
  drift:     'Drift',
  pulse:     'Breathe',
  grain:     'Film grain',
  scanlines: 'Scanlines',
  glitch:    'Glitch'
};

/* Alte gespeicherte Werte auf die neue Aufteilung umbiegen. */
/* Name der Auffang-Kategorie. Sie nimmt Bilder ohne eigene Zuordnung auf und
   laesst sich nicht loeschen - beim Loeschen anderer Kategorien landen deren
   Bilder hier, statt verwaist zu werden. */
const FALLBACK_CATEGORY = 'Uncategorized';

/* Bis Version 3.4.3 hiess sie 'Standard'. Der Name steht an jedem Bild in der
   Datenbank, ein blosses Umbenennen wuerde also eine zweite, leere Kategorie
   erzeugen und die vorhandenen Bilder verwaist zuruecklassen. */
const LEGACY_FALLBACK_CATEGORY = 'Standard';

const legacyTransitionMap = {
  /* rotateY auf einer vollflaechigen Ebene laeuft in Electron unrund - der
     Browser muss dafuer jedes Bild neu rastern. Ersatzlos gestrichen,
     gespeicherte Werte landen auf "Drehen". */
  flip:     { type: 'spin' },
  svgwipe:  { type: 'wipe' },
  cube:     { type: 'spin' },
  focus:    { type: 'blur' },
  pixelate: { type: 'zoom' },
  particle: { type: 'fade' },
  kenburns: { type: 'fade', ambient: 'kenburns' },
  parallax: { type: 'fade', ambient: 'drift' },
  glitch:   { type: 'fade', ambient: 'glitch' },
  film:     { type: 'fade', ambient: 'grain' }
};

function migrateTransition(transition) {
  const t = { ...(transition || {}) };
  if (!t.ambient) t.ambient = 'none';
  const mapped = legacyTransitionMap[t.type];
  if (mapped) {
    t.type = mapped.type;
    if (mapped.ambient && t.ambient === 'none') t.ambient = mapped.ambient;
  }
  if (typeof t.ambientSpeed !== 'number' || !isFinite(t.ambientSpeed)) t.ambientSpeed = 100;
  t.ambientSpeed = Math.min(600, Math.max(10, t.ambientSpeed));
  if (!transitionTypes[t.type]) t.type = 'fade';
  if (!ambientTypes[t.ambient]) t.ambient = 'none';
  return t;
}

module.exports = meta => {
  'use strict';
  const defaultSettings = {
    enableDrop: false,
    transition: { enabled: true, duration: 1000, type: 'fade', ambient: 'none', ambientSpeed: 100 },
    slideshow: { enabled: false, interval: 10000, shuffle: true, favoritesOnly: false, categoryFilter: null, categoryFilters: [] },
    // Standard AUS: das Plugin bringt seine eigene Hintergrund-Ebene mit (siehe
    // viewTransition.create). overwriteCSS ist nur ein Kompatibilitaets-Feature fuer
    // fremde Themes, die ihren Hintergrund ueber eine eigene CSS-Variable setzen.
    overwriteCSS: false,
    adjustment: {
      xPosition: 0,
      yPosition: 0,
      dimming: 0,
      blur: 0,
      grayscale: 0,
      saturate: 100,
      contrast: 100
    },
    addContextMenu: true,
    categories: [FALLBACK_CATEGORY],
    selectedCategory: null
  }

  /** @type { {settings: typeof defaultSettings, [key: string]: unknown} } */
  const constants = {};

  // ObjectURL helpers to centralize create/revoke and avoid leaks
  function ensureObjectURL(item) {
    try {
      if (!item) return null;
      if (item.src) return item.src;
      if (item._bgObjectURL) return item._bgObjectURL;
      if (item.image) {
        const url = URL.createObjectURL(item.image);
        item._bgObjectURL = url;
        // also mirror to src for older codepaths
        item.src = url;
        return url;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function setObjectURL(target, blob) {
    try {
      if (!target) return null;
      if (target._bgObjectURL) {
        try { URL.revokeObjectURL(target._bgObjectURL); } catch (e) {}
        target._bgObjectURL = null;
      }
      if (!blob) {
        target.src = null;
        return null;
      }
      const url = URL.createObjectURL(blob);
      target._bgObjectURL = url;
      target.src = url;
      return url;
    } catch (e) { return null; }
  }

  function clearObjectURL(target) {
    try {
      if (!target) return;
      if (target._bgObjectURL) {
        try { URL.revokeObjectURL(target._bgObjectURL); } catch (e) {}
        target._bgObjectURL = null;
      }
      if (target.src && (!target.image || target.src !== target.image)) target.src = null;
    } catch (e) { /* ignore */ }
  }
  /**
   * @typedef {Object} ImageItem
   * @property {Blob} image - The image blob.
   * @property {boolean} selected - The selected Image for the background.
   * @property {boolean} favorite - Whether the image is marked as favorite.
   * @property {string} category - The category/folder of the image.
   * @property {string} src - The objectURL for the image
   * @property {number} id - The ID of the image.
   * @property {width} width - The width of the image.
   * @property {height} height - The height of the image.
  */

  // Hooks
  /** @returns {[typeof defaultSettings, React.Dispatch<typeof defaultSettings>]} */
  function useSettings() {
    const [settings, setSettings] = useState(constants.settings);
    const setSyncedSettings = useCallback((newSettings) => {
      setSettings((prevSettings) => {
        const updatedSettings = newSettings instanceof Function ? newSettings(prevSettings) : newSettings;
        Data.save(meta.slug, 'settings', updatedSettings);
        constants.settings = { ...updatedSettings };
        return updatedSettings;
      });
    }, []);

    return [settings, setSyncedSettings]
  }

  /**
   * Utility function to open an IndexedDB database.
   * @param {string} storeName - The name of the object store.
   * @returns {Promise<IDBDatabase>} A promise that resolves to the database instance.
   */
  function openDB(storeName) {
    return new Promise((resolve, reject) => {
      // Erst oeffnen und pruefen; fehlt der Store, mit erhoehter Version nachlegen.
      const probe = indexedDB.open(DATA_BASE_NAME);

      probe.onupgradeneeded = event => {
        /** @type {IDBDatabase} */
        const db = event.target.result;
        if (!db.objectStoreNames.contains(storeName))
          db.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
      };

      probe.onsuccess = event => {
        /** @type {IDBDatabase} */
        const db = event.target.result;
        if (db.objectStoreNames.contains(storeName)) return resolve(db);

        // Store fehlt -> Version hochziehen und nachtraeglich anlegen.
        const nextVersion = db.version + 1;
        db.close();
        const upgrade = indexedDB.open(DATA_BASE_NAME, nextVersion);
        upgrade.onupgradeneeded = e => {
          const upgraded = e.target.result;
          if (!upgraded.objectStoreNames.contains(storeName))
            upgraded.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
        };
        upgrade.onsuccess = e => resolve(e.target.result);
        upgrade.onerror = e => reject(e.target.error);
        upgrade.onblocked = () => reject(new Error(
          `IndexedDB-Upgrade blockiert: eine andere Verbindung zu "${DATA_BASE_NAME}" ist noch offen.`
        ));
      };

      probe.onerror = event => {
        reject(event.target.error);
      };
    });
  };

  /**
   * Utility function to get all items from the store.
   * @param {IDBDatabase} db - The database instance.
   * @param {string} storeName - The name of the object store.
   * @returns {Promise<ImageItem[]>} A promise that resolves to an array of items.
   */
  function getAllItems(db, storeName) {
    return new Promise((resolve, reject) => {
      const store = db.transaction([storeName], 'readonly').objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  };

  /**
   * Utility function to save items to the store.
   * @param {IDBDatabase} db - The database instance.
   * @param {string} storeName - The name of the object store.
   * @param {ImageItem[]} newItems - The items to save.
   * @param {ImageItem[]} prevItems - The previous state of items.
   * @returns {Promise<void>}
   */
  function saveItems(db, storeName, newItems, prevItems) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      const newIds = new Set(newItems.map(item => item.id));
      const prevIds = new Set(prevItems.map(item => item.id));

      // Add/update items
      newItems.forEach(e => {
        if (!prevIds.has(e.id)) {
          store.add(e);
        } else {
          store.put(e);
        }
      });

      // Remove deleted items
      prevItems.forEach(item => {
        if (!newIds.has(item.id)) {
          store.delete(item.id);
        }
      });

      transaction.oncomplete = () => {
        try {
          // Keep an in-memory cache of images to avoid repeated DB reads
          constants._cachedImages = Array.isArray(newItems) ? newItems.map(e => ({ ...e })) : [];
        } catch (e) { /* ignore */ }
        resolve();
      };
      transaction.onerror = (event) => {
        reject(event.target.error);
      };
    });
  };

  /**
   * Custom hook for IndexedDB.
   * @param {string} storeName - The name of the object store.
   * @returns {[ImageItem[], React.Dispatch<React.SetStateAction<ImageItem[]>]} An array containing the items and a function to add items.
   */
  function useIDB(storeName = 'images') {
    /** @type [ImageItem[], React.Dispatch<React.SetStateAction<ImageItem[]>>] */
    const [items, setItems] = useState([]);
    const countEffect = useRef(0);
    const accessDB = useCallback(/** @param {(storedItems: ImageItem[], database: IDBDatabase) => void} cb */ cb => {
      /** @type {IDBDatabase | undefined} db */
      let db;
      openDB(storeName).then(database => {
        db = database;
        return getAllItems(db, storeName);
      }).then(storedItems =>
        cb(storedItems, db)
      ).catch(err => {
        console.error('Error opening database: ', err);
      }).finally(() => {
        db?.close();
      });
    }, []);

    useEffect(() => {
      accessDB(storedItems => {
        setItems(storedItems.map(e => {
          if (!e.src) ensureObjectURL(e);
          return e;
        }))
      })
      return () => {
        accessDB((storedItems, db) => {
          const clearedItems = storedItems.map(e => {
            if (!e.selected) {
                clearObjectURL(e);
              e.src = null;
            }
            return e;
          });
          saveItems(db, storeName, clearedItems, storedItems);
        })
      }
    }, []);
    const itemsRef = useRef(items);
    useEffect(() => { itemsRef.current = items }, [items]);
    const saveChainRef = useRef(Promise.resolve());

    useEffect(() => {
      countEffect.current++;
      if (countEffect.current > 1) {
        // Chain onto the previous save so writes happen strictly one at a time, and always
        // persist the LATEST items (itemsRef.current) rather than the value captured when this
        // effect fired. Without this, uploading several images at once could trigger multiple
        // overlapping save cycles; a slower one finishing after a faster one would see the
        // faster one's newly-added items as "not in my newItems list" and delete them again.
        saveChainRef.current = saveChainRef.current.then(() => new Promise(resolve => {
          accessDB((storedItems, db) => {
            saveItems(db, storeName, itemsRef.current, storedItems).then(resolve).catch(err => { console.error('Error saving images: ', err); resolve(); });
          });
        }));
      }
    }, [items]);

    return [items, setItems];
  };

  // Similar to useState, but also returns a ref with the current state. Useful when you need the most recent state when unmounting.
  function useStateWithRef(initial) {
    const [state, setState] = useState(initial);
    const ref = useRef(state);
    const setStateAndRef = useCallback((newState) => {
      ref.current = newState instanceof Function ? newState(ref.current) : newState;
      setState(newState);
    }, [setState]);

    return [state, setStateAndRef, ref];
  }

  // Components
  function IconComponent({ onClick, ...props }) {
    const handleKeyDown = useCallback(e => {
      props.onKeyDown?.(e);
      if (e.key === 'Enter' || e.key === ' ') onClick();
    }, [onClick, props.onKeyDown]);
    return jsx(IconButton, {
      TooltipProps: { text: 'Background Manager', position: 'bottom', shouldShow: props.showTooltip },
      ButtonProps: {
        ...props,
        component: 'div',
        tabIndex: '0',
        onKeyDown: handleKeyDown,
        onClick: onClick,
        className: [constants.toolbarClasses?.iconWrapper, !props.showTooltip ? constants.toolbarClasses?.selected : undefined, constants.toolbarClasses?.clickable].join(' '),
      },
      SvgProps: {
        path: "M20 4v12H8V4zm0-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-8.5 9.67 1.69 2.26 2.48-3.1L19 15H9zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6z",
        className: constants.toolbarClasses?.icon,
      }
    })
  }

  function ManagerComponent({ onRequestClose }) {
    const mainComponent = useRef(null);
    useEffect(() => {
      let mouseDownOnPopout = false;
      const layerContainer = reverseQuerySelector(mainComponent.current, '.' + constants.layerContainerClass?.layerContainer);
      if (!layerContainer) return;

      const ctrl = new AbortController();
      constants.settings.enableDrop && layerContainer.style.setProperty('z-index', '2002');
      addEventListener('mousedown', e => {
        mouseDownOnPopout = layerContainer.contains(e.target)
      }, ctrl);
      addEventListener('mouseup', e => {
        // If a context menu was just opened by our code, suppress closing the popout briefly
        if (constants._suppressClose) { constants._suppressClose = false; return; }
        // Prüfen ob Klick in einem Kontextmenü oder Layer war
        const isInContextMenu = e.target.closest('[class*="menu"], [class*="layer"], [class*="popout"], [role="menu"], [role="listbox"]');
        if (mouseDownOnPopout || layerContainer.contains(e.target) || e.target.closest('#' + meta.slug) || isInContextMenu) return;
        onRequestClose();
      }, ctrl);
      addEventListener('keydown', e => {
        e.key === 'Escape' && layerContainer.childElementCount === 1 && (onRequestClose(), e.stopPropagation())
      }, { capture: true, signal: ctrl.signal });

      return () => {
        layerContainer.style.removeProperty('z-index');
        ctrl.abort();
      }
    }, []);
    // FocusLock deaktiviert - verursacht Probleme mit dem Settings-Menü
    // !constants.settings.enableDrop && constants.nativeUI.useFocusLock?.(mainComponent);

    return jsx('div', {
      ref: mainComponent,
      role: "dialog",
      tabIndex: "-1",
      "aria-modal": "true",
      style: { overflow: 'visible' },
      className: [constants.messagesPopoutClasses?.messagesPopoutWrap, 'BackgroundManager-popoutWrap'].filter(Boolean).join(' '),
    }, jsx('div', { className: 'BackgroundManager-popoutInner' }, jsx(ManagerHead), jsx(ManagerBody)) )
  }

  function ManagerHead() {
    return jsx('div', {
      className: [constants.messagesPopoutClasses?.header, 'BackgroundManager-head'].filter(Boolean).join(' ')
      }, jsx('h1', {
        className: [constants.textStyles?.defaultColor, constants.textStyles?.['heading-md/medium']].join(' '),
      }, "Background Manager"));
  }

  function ManagerBody() {
    const [images, setImages] = useIDB();
    const [settings, setSettings] = useSettings();
    const [stackOffsets, setStackOffsets] = useState({});
    const [stackAnimating, setStackAnimating] = useState({});
    const [showCategoryInput, setShowCategoryInput] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');
    const categoryInputRef = useRef(null);

    // State: Slideshow nur Favoriten (initial from saved settings)
    const [slideshowFavoritesOnly, setSlideshowFavoritesOnly] = useState(constants.settings?.slideshow?.favoritesOnly || false);
    // Export Overlay State
    const [showExportOverlay, setShowExportOverlay] = useState(false);
    // Bildübersicht bleibt immer gleich (nur Kategorie-Filter)
    const filteredImages = useMemo(() => {
      let imgs = images;
      if (settings.selectedCategory) imgs = imgs.filter(img => (img.category || FALLBACK_CATEGORY) === settings.selectedCategory);
      return imgs;
    }, [images, settings.selectedCategory]);

    // Gruppiere Bilder pro Kategorie für die Stack-Übersicht
    const groupedByCategory = useMemo(() => {
      const map = {};
      (settings.categories || []).forEach(c => map[c] = []);
      for (const img of images) {
        const c = img.category || FALLBACK_CATEGORY;
        if (!map[c]) map[c] = [];
        map[c].push(img);
      }
      return map;
    }, [images, settings.categories]);

    /* ALLE vorhandenen Kategorien: die eingetragenen PLUS die, die nur noch an
       Bildern haengen. Ohne diese Vereinigung waeren Bilder verwaister
       Kategorien in der Oberflaeche unerreichbar. */
    const allCategories = useMemo(() => {
      const seen = new Set();
      const out = [];
      for (const c of [...(settings.categories || []), ...Object.keys(groupedByCategory)]) {
        if (c && !seen.has(c)) { seen.add(c); out.push(c); }
      }
      return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }, [settings.categories, groupedByCategory]);

    /* Selbstheilung: verwaiste Kategorien zurueck in die Einstellungen, damit
       sie auch in den Auswahllisten auftauchen. */
    useEffect(() => {
      const known = new Set(settings.categories || []);
      const orphans = Object.keys(groupedByCategory)
        .filter(c => c && !known.has(c) && (groupedByCategory[c] || []).length > 0);
      if (!orphans.length) return;
      console.log('%c[DynamicBackgrounds] %cVerwaiste Kategorien wiederhergestellt:', "color:#DBDCA6;font-weight:bold", "", orphans);
      setSettings(prev => ({ ...prev, categories: [...(prev.categories || []), ...orphans] }));
    }, [groupedByCategory, settings.categories]);

    // Preload cache to avoid blank images when rotating stacks
    const preloadCache = useRef(new Set());

    // Warm-cache: preload all image.src URLs (objectURLs) so showing them is instant
    // Throttle preloads using small batches to avoid CPU/memory spikes
    useEffect(() => {
      let cancelled = false;
      const toPreload = images.filter(it => it && it.src && !preloadCache.current.has(it.id));
      const batchSize = 6;
      let idx = 0;
      const runBatch = () => {
        if (cancelled) return;
        const end = Math.min(idx + batchSize, toPreload.length);
        for (; idx < end; idx++) {
          const it = toPreload[idx];
          try {
            const img = new Image();
            img.src = it.src;
            if (img.decode) {
              img.decode().then(() => { if (!cancelled) preloadCache.current.add(it.id); }).catch(() => { if (!cancelled) preloadCache.current.add(it.id); });
            } else {
              img.onload = () => { if (!cancelled) preloadCache.current.add(it.id); };
            }
          } catch (e) { /* ignore */ }
        }
        if (idx < toPreload.length) {
          if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
          else setTimeout(runBatch, 50);
        }
      };
      if (toPreload.length) {
        if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
        else setTimeout(runBatch, 50);
      }
      return () => { cancelled = true; };
    }, [images]);

    // When stack offsets change, ensure the upcoming window images are preloaded (reduces flicker)
    // Throttled and batched similar to the global warm-cache
    useEffect(() => {
      let cancelled = false;
      try {
        const candidates = [];
        Object.keys(stackOffsets).forEach(cat => {
          const items = groupedByCategory[cat] || [];
          const m = items.length;
          if (!m) return;
          const offset = stackOffsets[cat] || 0;
          const toPreload = Math.min(6, m);
          for (let i = 0; i < toPreload; i++) {
            const it = items[(offset + i) % m];
            if (!it || !it.src) continue;
            if (preloadCache.current.has(it.id)) continue;
            candidates.push(it);
          }
        });
        const batchSize = 6;
        let idx = 0;
        const runBatch = () => {
          if (cancelled) return;
          const end = Math.min(idx + batchSize, candidates.length);
          for (; idx < end; idx++) {
            const it = candidates[idx];
            try {
              const img = new Image();
              img.src = it.src;
              if (img.decode) {
                img.decode().then(() => { if (!cancelled) preloadCache.current.add(it.id); }).catch(() => { if (!cancelled) preloadCache.current.add(it.id); });
              } else {
                img.onload = () => { if (!cancelled) preloadCache.current.add(it.id); };
              }
            } catch (e) { /* ignore */ }
          }
          if (idx < candidates.length) {
            if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
            else setTimeout(runBatch, 50);
          }
        };
        if (candidates.length) {
          if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
          else setTimeout(runBatch, 50);
        }
      } catch (e) { /* ignore */ }
      return () => { cancelled = true; };
    }, [stackOffsets, groupedByCategory, images]);

    /* Filter-Zustand fuer den Diashow-Manager. Bewusst auf constants und NICHT
       auf window: die BD-Richtlinien untersagen das Veraendern globaler Objekte,
       und constants verschwindet mit dem Plugin. */
    useEffect(() => {
      constants._slideshowFavoritesOnly = slideshowFavoritesOnly;
    }, [slideshowFavoritesOnly]);

    // Synchronisiere Kategorie-Filter-State für Slideshow persistent in Settings
    useEffect(() => {
      // Support both legacy single-value and new multi-value filters
      const filters = settings.slideshow?.categoryFilters?.length ? settings.slideshow.categoryFilters : (settings.slideshow?.categoryFilter ? [settings.slideshow.categoryFilter] : null);
      constants._slideshowCategoryFilters = filters;
    }, [settings.slideshow?.categoryFilters, settings.slideshow?.categoryFilter]);

    // Wenn die Einstellung extern (oder beim Laden) geändert wurde, synchronisiere den lokalen Toggle
    useEffect(() => {
      const fav = !!settings?.slideshow?.favoritesOnly;
      if (fav !== slideshowFavoritesOnly) setSlideshowFavoritesOnly(fav);
    }, [settings?.slideshow?.favoritesOnly]);

    const contextMenuObj = useMemo(() => {
      const saveAndCopy = givenItem => [givenItem.image.type !== 'image/gif' && {
        label: "Copy image",
        action: async () => {
          try {
            if (givenItem.image.type === 'image/png' || givenItem.image.type === 'image/jpeg') {
              const arrayBuffer = await givenItem.image.arrayBuffer()
              DiscordNative.clipboard.copyImage(new Uint8Array(arrayBuffer), givenItem.src)
            } else {
              const imageBitmap = await createImageBitmap(givenItem.image);
              const Canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
              const ctx = Canvas.getContext('2d');
              ctx.drawImage(imageBitmap, 0, 0);
              const pngBlob = await Canvas.convertToBlob({ type: 'image/png' });
              const arrayBuffer = await pngBlob.arrayBuffer()
              DiscordNative.clipboard.copyImage(new Uint8Array(arrayBuffer), givenItem.src)
            }
            UI.showToast("Image copied to clipboard.", { type: 'success' });
          } catch (err) {
              UI.showToast("Image could not be copied. " + err, { type: 'error' });
          }
        }
      }, {
        label: "Save image",
        action: async () => {
          try {
            const arrayBuffer = new Uint8Array(await givenItem.image.arrayBuffer());
            let url = givenItem.image.name
            if (!url) {
              url = (new URL(givenItem.src)).pathname.split('/').pop() || 'unknown';
              const FileExtension = {
                jpeg: [[0xFF, 0xD8, 0xFF, 0xEE]],
                jpg: [[0xFF, 0xD8, 0xFF, 0xDB], [0xFF, 0xD8, 0xFF, 0xE0], [0xFF, 0xD8, 0xFF, 0xE1]],
                png: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
                bmp: [[0x42, 0x4D]],
                gif: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
                heic: [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]],
                avif: [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]],
                webp: [[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]],
                svg: [[0x3C, 0x73, 0x76, 0x67]],
                ico: [[0x00, 0x00, 0x01, 0x00]],
              }
              loop: for (const [ext, signs] of Object.entries(FileExtension)) {
                for (const sign of signs) {
                  if (sign.every((e, i) => e === null || e === arrayBuffer[i])) {
                    url += '.' + ext;
                    break loop;
                  }
                }
              }
            }
            DiscordNative.fileManager.saveWithDialog(arrayBuffer, url).then(() => {
              UI.showToast("Saved Image!", { type: 'success' });
            });
          } catch (err) {
            UI.showToast("Failed to save Image. " + err, { type: 'error' });
          }
        }
      }].filter(Boolean);
      return {
        saveAndCopy,
        lazyCarousel: constants.lazyCarousel ? (givenItem) => {
          try {
            constants.lazyCarousel({
              items: images.map(img => ({
                url: img.src, original: "",
                zoomThumbnailPlaceholder: img.src,
                contentType: img.image.type,
                srcIsAnimated: img.image.type === 'image/gif',
                type: 'IMAGE',
                width: img.width, height: img.height,
                sourceMetadata: {
                  identifier: {
                    filename: img.image.name,
                    size: img.image.size,
                    type: "attachment"
                  }
                },
              })),
              location: "Media Mosaic",
              startingIndex: givenItem.id - 1,
              onContextMenu: e => {
                const src = e.target.closest(`img`)?.src;
                if (!src) return;
                ContextMenu.open(e, ContextMenu.buildMenu(saveAndCopy(images.find(e => e.src === src))))
              },
            })
          } catch (err) { console.error(err) }
        } : null
      }
    }, [images]);
    const handleSelect = useCallback(index => {
      setImages(prev => {
        prev.forEach(e => {
          e.selected = e.id === index;
        });
        return [...prev];
      });
    }, [setImages]);
    const onNextShuffle = useCallback(() => {
      const currentIndex = images.reduce((p, c, i) => c.selected ? i : p, null);
      let x, it = 0;
      do x = constants.settings.slideshow.shuffle || currentIndex === null ? Math.floor(Math.random() * images.length) : (currentIndex + 1) % images.length
      while (x === currentIndex && it++ < 25)
      const item = images[x];
      handleSelect(item.id);
      constants.settings.slideshow.enabled ? slideShowManager.start() : slideShowManager.stop();
      viewTransition.setImage(item.src);
    }, [images, handleSelect]);

    // Kategorie-Funktionen
    const handleCategoryChange = useCallback((imageId, category) => {
      setImages(prev => prev.map(img => img.id === imageId ? { ...img, category } : img));
    }, [setImages]);

    const handleAddCategory = useCallback(() => {
      if (newCategoryName.trim() && !settings.categories.includes(newCategoryName.trim())) {
        setSettings(prev => ({ ...prev, categories: [...prev.categories, newCategoryName.trim()] }));
        setNewCategoryName('');
        setShowCategoryInput(false);
      }
    }, [newCategoryName, settings.categories, setSettings]);

    const handleDeleteCategory = useCallback((categoryToDelete) => {
      if (categoryToDelete === FALLBACK_CATEGORY) return;

      /* Rueckfrage vor dem Loeschen. Die Bilder bleiben erhalten und wandern
         nach FALLBACK_CATEGORY - das steht bewusst im Text, sonst rechnet man
         mit Datenverlust und traut sich nicht. Bei leeren Kategorien entfaellt
         die Rueckfrage, da gibt es nichts zu verlieren. */
      const affected = images.filter(img => (img.category || FALLBACK_CATEGORY) === categoryToDelete).length;
      if (affected > 0) {
        const message = affected === 1
          ? `Delete the category "${categoryToDelete}"?\n\n1 image will be moved to "${FALLBACK_CATEGORY}". No images are deleted.`
          : `Delete the category "${categoryToDelete}"?\n\n${affected} images will be moved to "${FALLBACK_CATEGORY}". No images are deleted.`;
        if (!confirm(message)) return;
      }

      // Bilder in dieser Kategorie auf die Auffang-Kategorie setzen
      setImages(prev => prev.map(img => img.category === categoryToDelete ? { ...img, category: FALLBACK_CATEGORY } : img));
      // Kategorie aus Liste entfernen
      setSettings(prev => {
        const nextFilters = (prev.slideshow?.categoryFilters || []).filter(c => c !== categoryToDelete);
        const nextSingleFilter = prev.slideshow?.categoryFilter === categoryToDelete ? null : prev.slideshow?.categoryFilter;
        return {
          ...prev,
          categories: prev.categories.filter(c => c !== categoryToDelete),
          selectedCategory: prev.selectedCategory === categoryToDelete ? null : prev.selectedCategory,
          // Otherwise a deleted category could stay stuck as the slideshow filter, silently leaving
          // the slideshow with zero matching images and no indication why.
          slideshow: { ...prev.slideshow, categoryFilters: nextFilters, categoryFilter: nextSingleFilter }
        };
      });
      // images muss in die Abhaengigkeiten: die Rueckfrage zaehlt daraus die
      // betroffenen Bilder, sonst arbeitet sie mit einem veralteten Stand.
    }, [images, setImages, setSettings]);

    // Export Handler
    const handleDownloadImage = useCallback(async (img) => {
      try {
        console.log('Download attempt for image:', img);
        let blob;
        
        if (img.image && img.image instanceof Blob) {
          // Use the stored blob directly from IndexedDB
          blob = img.image;
          console.log('Using stored blob, size:', blob.size);
        } else if (img.src) {
          // Fallback: fetch from object URL or regular URL
          console.log('Fetching from src:', img.src);
          const response = await fetch(img.src);
          blob = await response.blob();
          console.log('Fetched blob, size:', blob.size);
        } else {
          console.error('No image data available for download');
          UI.showToast("Image cannot be downloaded - no data available", { type: 'error' });
          return;
        }
        
        const fileName = img.name || `background_${img.id}.jpg`;
        console.log('Using filename:', fileName);
        
        // Always use browser fallback for reliability
        console.log('Using browser download method');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.showToast(`"${fileName}" heruntergeladen!`, { type: 'success' });
      } catch (error) {
        console.error('Download failed:', error);
        UI.showToast("Download failed: " + error.message, { type: 'error' });
      }
    }, []);

    const handleDownloadAllZip = useCallback(async () => {
      try {
        const entries = [];
        const usedNames = new Set();

        for (const img of filteredImages) {
          let blob;
          if (img.image) {
            blob = img.image;
          } else if (img.src) {
            const response = await fetch(img.src);
            blob = await response.blob();
          } else {
            continue;
          }

          // Bilder in Ordner nach Kategorie. Kategorien und Favoriten liegen nur
          // in der IndexedDB - ohne Ordner waere die Einteilung nach einem
          // Wiederherstellen verloren.
          const folder = String(img.category || FALLBACK_CATEGORY).replace(/[\\/:*?"<>|]/g, '_');
          let name = folder + '/' + (img.name || `background_${img.id}.jpg`);

          // Gleiche Dateinamen in derselben Kategorie durchnummerieren, sonst
          // ueberschreiben sich Eintraege beim Entpacken gegenseitig.
          if (usedNames.has(name)) {
            const dot = name.lastIndexOf('.');
            const base = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let n = 2;
            while (usedNames.has(`${base} (${n})${ext}`)) n++;
            name = `${base} (${n})${ext}`;
          }
          usedNames.add(name);

          entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
        }

        if (!entries.length) return UI.showToast('No images to export', { type: 'info' });

        const content = createZipBlob(entries);

        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'backgrounds.zip';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.showToast("ZIP file downloaded", { type: 'success' });
      } catch (error) {
        console.error('ZIP Download failed:', error);
        UI.showToast("Could not create the ZIP file: " + error.message, { type: 'error' });
      }
    }, [filteredImages]);

    return jsx(Fragment, {
      children: [
        jsx('div', {
          className: [constants.messagesPopoutClasses?.messageGroupWrapper, constants.markupStyles?.markup, constants.messagesPopoutClasses?.messagesPopout].join(' '),
          style: { display: "grid", gridTemplateRows: 'auto auto auto 1fr', overflowX: 'visible', overflowY: 'hidden', border: '0' },
          children: [
            jsx(InputComponent, { setImages, currentCategory: settings.selectedCategory }),
            /* WERKZEUGLEISTE
               Zwei beschriftete Zeilen statt einer Reihe gleich aussehender
               Knoepfe. "Favorites" allein sagt niemandem, ob damit gefiltert,
               markiert oder geloescht wird - erst die Ueberschrift "Slideshow"
               darueber macht klar, worauf sich der Schalter bezieht.
               Zeile 1 steuert, WAS laeuft. Zeile 2 verwaltet die Sammlung. */
            jsx('div', {
              className: 'BackgroundManager-toolbar',
              children: [
                jsx('div', {
                  key: 'row-slideshow',
                  className: 'BackgroundManager-toolRow',
                  children: [
                    jsx('span', { key: 'l', className: 'BackgroundManager-toolLabel' }, 'Slideshow'),

                    // Diashow anhalten und fortsetzen
                    jsx('button', {
                      key: 'play',
                      className: 'BackgroundManager-chip' + (settings.slideshow?.enabled ? ' active' : ''),
                      title: settings.slideshow?.enabled ? 'Pause the slideshow' : 'Start the slideshow',
                      onClick: () => {
                        const next = !settings.slideshow?.enabled;
                        setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: next } }));
                        next ? slideShowManager.start() : slideShowManager.stop();
                      },
                      children: [
                        jsx('svg', { key: 'i', width: 13, height: 13, viewBox: '0 0 24 24', fill: 'currentColor',
                          children: settings.slideshow?.enabled
                            ? jsx('path', { d: 'M6 5h4v14H6zM14 5h4v14h-4z' })
                            : jsx('path', { d: 'M7 4l13 8-13 8z' }) }),
                        jsx('span', { key: 't' }, settings.slideshow?.enabled ? 'Running' : 'Paused')
                      ]
                    }),

                    // Favoriten-Filter
                    jsx('button', {
                      key: 'fav',
                      className: 'BackgroundManager-chip' + (slideshowFavoritesOnly ? ' active' : ''),
                      title: slideshowFavoritesOnly ? 'Slideshow uses favorites only' : 'Slideshow uses all images',
                      onClick: () => {
                        setSlideshowFavoritesOnly(prev => {
                          const next = !prev;
                          setSettings(s2 => ({ ...s2, slideshow: { ...s2.slideshow, favoritesOnly: next } }));
                          return next;
                        });
                      },
                      children: [
                        jsx('svg', { key: 'i', width: 15, height: 15, viewBox: '0 0 24 24', fill: slideshowFavoritesOnly ? '#FFD700' : 'none', stroke: slideshowFavoritesOnly ? '#FFD700' : 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
                          children: jsx('path', { d: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z' }) }),
                        jsx('span', { key: 't' }, slideshowFavoritesOnly ? 'Favorites only' : 'All images')
                      ]
                    }),

                    jsx(CategoryQuickButton, {
                      key: 'cats',
                      categories: allCategories,
                      value: settings.slideshow?.categoryFilters || (settings.slideshow?.categoryFilter ? [settings.slideshow.categoryFilter] : []),
                      onChange: arr => setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, categoryFilters: Array.isArray(arr) ? arr : (arr ? [arr] : []), categoryFilter: Array.isArray(arr) && arr.length === 1 ? arr[0] : (typeof arr === 'string' ? arr : null) } })),
                    }),

                    jsx('button', {
                      key: 'next',
                      className: 'BackgroundManager-chip',
                      title: 'Show the next background now',
                      onClick: onNextShuffle,
                      children: [
                        jsx('svg', { key: 'i', width: 13, height: 13, viewBox: '0 0 24 24', fill: 'currentColor',
                          children: jsx('path', { d: 'M5 4l10 8-10 8zM17 4h3v16h-3z' }) }),
                        jsx('span', { key: 't' }, 'Next')
                      ]
                    }),

                    /* Ueberlaufmenue und Einstellungen bilden rechts eine eigene
                       Gruppe mit Abstand - sie gehoeren nicht zu den Filtern. */
                    jsx('div', {
                      key: 'end',
                      className: 'BackgroundManager-toolEnd',
                      children: [
                        jsx('button', {
                          key: 'more',
                          className: 'BackgroundManager-iconButton',
                          title: 'More actions',
                          'aria-label': 'More actions',
                          onClick: e => {
                            e.preventDefault();
                            const cats = allCategories;
                            ContextMenu.open(e, ContextMenu.buildMenu([
                              {
                                label: 'Open category',
                                type: 'submenu',
                                items: [
                                  { label: 'All categories', action: () => setSettings(prev => ({ ...prev, selectedCategory: null })) },
                                  { type: 'separator' },
                                  ...cats.map(cat => ({
                                    label: cat + (groupedByCategory[cat] && groupedByCategory[cat].length
                                      ? ' (' + groupedByCategory[cat].length + ')' : ' (empty)'),
                                    action: () => setSettings(prev => ({ ...prev, selectedCategory: cat }))
                                  }))
                                ]
                              },
                              { type: 'separator' },
                              {
                                label: 'Remove all favorites',
                                danger: true,
                                action: () => {
                                  try {
                                    if (!images || !images.some(i => i.favorite)) return UI.showToast('No favorites present.', { type: 'info' });
                                    if (confirm('Remove all favorites?')) {
                                      setImages(prev => prev.map(i => ({ ...i, favorite: false })));
                                      UI.showToast('All favorites removed.', { type: 'success' });
                                    }
                                  } catch (err) { console.error(err); UI.showToast('Error removing favorites.', { type: 'error' }); }
                                }
                              }
                            ]));
                          },
                          children: jsx('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', children: [
                            jsx('circle', { key: 'a', cx: 5, cy: 12, r: 1.7 }),
                            jsx('circle', { key: 'b', cx: 12, cy: 12, r: 1.7 }),
                            jsx('circle', { key: 'c', cx: 19, cy: 12, r: 1.7 })
                          ] })
                        }),
                        jsx(InPopoutSettings, { key: 'settings', rerender: setImages })
                      ]
                    })
                  ]
                }),

                jsx('div', {
                  key: 'row-library',
                  className: 'BackgroundManager-toolRow',
                  children: [
                    jsx('span', { key: 'l', className: 'BackgroundManager-toolLabel' }, 'Library'),
                    jsx('button', {
                      key: 'newcat',
                      className: 'BackgroundManager-chip',
                      title: 'Create a new category',
                      onClick: () => setShowCategoryInput(!showCategoryInput),
                      children: [jsx('span', { key: 'p', style: { fontSize: '15px', lineHeight: 1 } }, '+'), jsx('span', { key: 't' }, 'New category')]
                    }),
                    jsx('button', {
                      key: 'export',
                      className: 'BackgroundManager-chip',
                      title: 'Save all images as a ZIP file',
                      onClick: () => setShowExportOverlay(true),
                      children: [
                        jsx('svg', { key: 'i', width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
                          children: jsx('path', { d: 'M12 3v12m0 0l-4-4m4 4l4-4M4 19h16' }) }),
                        jsx('span', { key: 't' }, 'Export ZIP')
                      ]
                    })
                  ]
                })
              ]
            }),
            jsx('div', {
              role: 'separator',
              className: constants.separator?.separator,
              style: { marginRight: '0.75rem' }
            }),
            // Kategorie-Leiste
            jsx('div', {
              className: 'BackgroundManager-categoryBar',
              children: [
                // Categories button replaces select: opens context menu with all categories (including empty)
                /* Hier steht nur noch Zustandsabhaengiges. Leere Kategorien oeffnet man
                   ueber das Ueberlaufmenue ("Open category"). */
                settings.selectedCategory ? jsx('button', {
                  className: 'BackgroundManager-chip',
                  title: 'Back to the category overview',
                  onClick: () => setSettings(prev => ({ ...prev, selectedCategory: null })),
                  children: [jsx('span', { key: 'a' }, '\u2190'), jsx('span', { key: 't' }, 'All categories')]
                }) : null,
                settings.selectedCategory && settings.selectedCategory !== FALLBACK_CATEGORY ? jsx('button', {
                  className: 'BackgroundManager-categoryButton delete',
                  title: 'Delete category',
                  onClick: () => handleDeleteCategory(settings.selectedCategory),
                  children: '×'
                }) : null
              ]
            }),
            showCategoryInput ? jsx('div', {
              className: 'BackgroundManager-categoryInputRow',
              children: [
                jsx('input', {
                  ref: categoryInputRef,
                  type: 'text',
                  className: 'BackgroundManager-categoryInput',
                  placeholder: 'Category name...',
                  value: newCategoryName,
                  onChange: (e) => setNewCategoryName(e.target.value),
                  onKeyDown: (e) => e.key === 'Enter' && handleAddCategory()
                }),
                jsx('button', {
                  className: 'BackgroundManager-categoryButton',
                  onClick: handleAddCategory,
                  children: '✓'
                })
              ]
            }) : null,
            images.length ? jsx('div', {
              // Randinformation: klein und gedaempft
              style: {
                paddingInline: '0.25rem 0.75rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '12px',
                opacity: 0.55
              },
              className: constants.textStyles?.['text-sm/normal'],
              children: [
                'Total storage size: ' + formatNumber(images.reduce((p, c) => p + c.image.size, 0)) + (settings.selectedCategory ? ` (${filteredImages.length} of ${images.length})` : ''),
                constants.settings.slideshow.enabled && images.length >= 2 ? jsx(IconButton, {
                  TooltipProps: { text: 'Next background' },
                  ButtonProps: {
                    style: { padding: 0, marginRight: 9 },
                    onClick: onNextShuffle,
                    className: 'BackgroundManager-nextButton ' + constants.textStyles?.defaultColor,
                  },
                  SvgProps: {
                    width: '18', height: '18',
                    path: 'M5.7 6.71c-.39.39-.39 1.02 0 1.41L9.58 12 5.7 15.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l4.59-4.59c.39-.39.39-1.02 0-1.41L7.12 6.71c-.39-.39-1.03-.39-1.42 0M12.29 6.71c-.39.39-.39 1.02 0 1.41L16.17 12l-3.88 3.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l4.59-4.59c.39-.39.39-1.02 0-1.41L13.7 6.7c-.38-.38-1.02-.38-1.41.01'
                  }
                }) : null
              ],
            }) : null,
                jsx('div', {
                  className: ['BackgroundManager-gridWrapper', constants.scrollbar?.thin].join(' '),
                  style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, overflowX: 'visible', overflowY: 'auto' },
                  children: (settings.selectedCategory ? filteredImages.map((e, i) => jsx(ImageComponent, {
                    key: e.src,
                    item: e,
                    index: i,
                    contextMenuObj,
                    setImages,
                    onSelect: handleSelect,
                    categories: settings.categories,
                    onCategoryChange: handleCategoryChange
                  })) : allCategories.filter(cat => (groupedByCategory[cat] || []).length > 0).map(cat => {
                      const items = groupedByCategory[cat] || [];
                      const previews = items; // use full group; we'll only display up to 5 at a time
                      // Enthaelt diese Kategorie das Bild, das gerade laeuft?
                      const hasActive = items.some(i => i.selected);
                      return jsx('div', {
                      key: cat,
                      className: 'BackgroundManager-categoryStack' + (hasActive ? ' has-active' : ''),
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': `Category ${cat}`,
                      onKeyDown: (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSettings(prev => ({ ...prev, selectedCategory: cat })); } },
                        onClick: () => setSettings(prev => ({ ...prev, selectedCategory: cat })),
                        children: [jsx('div', {
                          key: 'stack',
                          style: { position: 'relative', height: 168, display: 'block' },
                          onMouseEnter: () => {
                            // Setzt nur den Offset - die Choreografie ergibt sich aus den
                            // Slot-Positionen unten und laeuft als eine Transition.
                            if (stackAnimating[cat]) return;
                            setStackAnimating(prev => ({ ...prev, [cat]: true }));
                            setStackOffsets(prev => {
                              const cur = prev[cat] || 0;
                              return { ...prev, [cat]: (cur + 1) % Math.max(1, previews.length) };
                            });
                            // dient nur noch als Sperre gegen erneutes Ausloesen waehrend der
                            // Bewegung - die Positionen haengen nicht mehr davon ab
                            setTimeout(() => {
                              setStackAnimating(prev => ({ ...prev, [cat]: false }));
                            }, STACK_ANIM_MS);
                          },
                          children: [(() => {
                            /* Drei Karten statt fuenf; die Rotation macht die Faecherung. */
                            const maxCount = 3;
                            const overlap = 26;   // vertikaler Versatz je Tiefe
                            const shiftX = 11;    // seitlicher Versatz je Tiefe
                            const tiltDeg = 2.6;  // Drehung je Tiefe
                            const m = previews.length;
                            const n = Math.min(m, maxCount);
                            const offset = stackOffsets[cat] || 0;
                            if (n === 0) return null;

                            /* SLOT-MODELL
                               Jedes Bild bekommt einen Slot; der Slot allein bestimmt Position,
                               Tiefe und Sichtbarkeit. Eine Rotation erhoeht bei JEDEM Bild den
                               Slot um genau 1 - und weil alle Slot-Eigenschaften animierbar
                               sind, gleitet der komplette Stapel in einem Zug.

                                 Slot -1  "auf Abruf": unter dem Stapel, unsichtbar
                                 Slot 0   unterste sichtbare Karte
                                 Slot n-1 oberste sichtbare Karte
                                 Slot n   "ausscheidend": geometrisch auf Slot -1 gesetzt

                               Der Trick steckt in Slot n. Rein rechnerisch laege das Bild ueber
                               dem Stapel, wir platzieren es aber bewusst dort, wo Slot -1 liegt.
                               Dadurch faehrt die oberste Karte beim Rotieren nach UNTEN, rutscht
                               hinter die anderen und blendet aus - genau die Bewegung, die du
                               wolltest, nur eben als Teil derselben Transition statt als
                               vorgeschaltete Show-Einlage.

                               Die Extra-Slots werden nur gerendert, wenn genug Bilder vorhanden
                               sind. Sonst wuerde dasselbe Bild zweimal auftauchen und React
                               haette doppelte keys. */
                            // Die ausscheidende Karte (Slot n) hat Vorrang vor der
                            // Abruf-Karte (Slot -1): ihre Reise ist der eigentliche Effekt.
                            // Bei genau einem Bild Reserve reicht es nur fuer eine von beiden,
                            // sonst gaebe es doppelte React-keys.
                            const renderExiting = m > n;
                            const renderOnDeck  = m > n + 1;
                            const fromSlot = renderOnDeck ? -1 : 0;
                            const toSlot   = renderExiting ? n : n - 1;

                            // Startpunkt der Reise = Position des obersten Slots.
                            // Das Ziel ist immer die RUHEPOSITION der jeweiligen Karte, wird
                            // also weiter unten pro Karte berechnet.
                            const yFrom = -(maxCount - 1) * overlap;
                            const xFrom = 0;

                            /* Wer macht die Reise?
                               - Normalfall (mehr Bilder als Slots): die Karte auf Slot n, also
                                 die gerade oben hinausgeschobene. Sie endet unsichtbar.
                               - Kategorien mit hoechstens 5 Bildern: hier gibt es keinen Slot n,
                                 das Fenster IST die ganze Gruppe. Die oberste Karte wandert
                                 direkt auf den untersten Slot 0 - und uebernimmt die Reise
                                 selbst, endet aber SICHTBAR. Genau dieser Fall fehlte vorher,
                                 deshalb ist die Karte dort einfach verschwunden.
                               Nur waehrend einer laufenden Rotation, sonst wuerde die Animation
                               schon beim ersten Rendern losspielen. */
                            const rotating = !!stackAnimating[cat];
                            const windowIsWholeGroup = (m === n);

                            const nodes = [];
                            for (let slot = fromSlot; slot <= toSlot; slot++) {
                              const p = previews[(((offset + n - 1 - slot) % m) + m) % m];
                              if (!p) continue;

                              const visible = slot >= 0 && slot <= n - 1;
                              // Slot n uebernimmt die Geometrie von Slot -1 (siehe oben)
                              const geomSlot = (slot === n) ? -1 : slot;
                              const isTraveling = rotating &&
                                (slot === n || (windowIsWholeGroup && slot === 0));

                              const baseBottom = (maxCount - n + geomSlot) * overlap;
                              const depth = n - 1 - geomSlot;
                              const horizontalOffset = -depth * shiftX;
                              const rotation = -depth * tiltDeg;
                              /* Abdunklung statt Schatten als Tiefenhinweis - funktioniert auf
                                 hellen wie dunklen Motiven. */
                              const dim = Math.max(0, 1 - depth * 0.22);

                              const targetOpacity = visible ? 1 : 0;
                              // Die Reise-Karte startet VORN (400). Wann sie nach hinten
                              // wechselt, steuern die Keyframes - nicht dieser Wert.
                              const z = isTraveling ? 400 : (visible ? slot + 150 : 1);
                              const shadow = visible
                                ? '0 10px 26px rgba(0,0,0,0.45)'
                                : '0 4px 12px rgba(0,0,0,0.3)';

                              nodes.push(jsx('img', {
                                key: p.id,
                                src: p.src || ensureObjectURL(p),
                                alt: '',
                                onLoad: e => {
                                  try {
                                    // auf den Zielwert setzen, nicht pauschal auf 1 - sonst
                                    // wuerden die unsichtbaren Slots sichtbar
                                    e.currentTarget.style.opacity = String(isTraveling ? 1 : targetOpacity);
                                    preloadCache.current.add(p.id);
                                  } catch (err) {}
                                },
                                style: {
                                  position: 'absolute',
                                  left: '50%',
                                  bottom: '0px',
                                  // Stapelhoehe steckt im transform, nicht in bottom: nur so
                                  // laeuft die gesamte Bewegung ueber eine einzige animierbare
                                  // Eigenschaft. (bottom positiv = hoch, translateY negativ =
                                  // hoch, daher das Minus.)
                                  transform: `translate3d(calc(-50% + ${horizontalOffset}px), ${-baseBottom}px, 0) rotate(${rotation}deg)`,
                                  filter: `brightness(${dim})`,
                                  width: '190px',
                                  height: '125px',
                                  objectFit: 'cover',
                                  borderRadius: 10,
                                  boxShadow: shadow,
                                  // Deutlich sichtbar, sonst verschwimmen aehnliche Bilder zu Streifen
                                  border: '1px solid rgba(255,255,255,0.13)',
                                  zIndex: z,
                                  opacity: isTraveling ? 1 : (preloadCache.current.has(p.id) ? targetOpacity : 0),
                                  // Keyframe-Koordinaten: Start ist der oberste Slot, Ziel ist
                                  // die Ruheposition dieser Karte.
                                  '--bm-x-from': `${xFrom}px`,
                                  '--bm-y-from': `${yFrom}px`,
                                  '--bm-x-to': `${horizontalOffset}px`,
                                  '--bm-y-to': `${-baseBottom}px`,
                                  '--bm-rot-to': `${rotation}deg`,
                                  '--bm-op-end': String(targetOpacity),
                                  // Die wandernde Karte laeuft ueber Keyframes mit
                                  // Zwischenstationen. Alle anderen interpolieren schlicht von
                                  // Slot zu Slot - aber mit Verzoegerung, damit sie erst
                                  // nachruecken, wenn die oberste Karte angehoben ist.
                                  animation: isTraveling
                                    ? `BackgroundManager-cardToBack ${STACK_TRAVEL_MS}ms cubic-bezier(0.33,0.02,0.28,1) forwards`
                                    : 'none',
                                  transition: isTraveling
                                    ? 'none'
                                    : `transform ${STACK_SHIFT_MS}ms cubic-bezier(0.22,0.61,0.36,1) ${STACK_SHIFT_DELAY_MS}ms, opacity ${STACK_SHIFT_MS}ms ease ${STACK_SHIFT_DELAY_MS}ms, box-shadow ${STACK_SHIFT_MS}ms ease ${STACK_SHIFT_DELAY_MS}ms`
                                }
                              }));
                            }
                            return nodes;
                          })()]
                        }),
                        /* Unter dem Stapel statt darauf: auf beliebigen Motiven waere ein Label
                           mal lesbar, mal nicht. */
                        jsx('div', {
                          key: 'label',
                          className: 'BackgroundManager-categoryLabel',
                          children: [
                            jsx('span', { key: 'n', className: 'BackgroundManager-categoryName', children: cat }),
                            jsx('span', { key: 'c', className: 'BackgroundManager-categoryCount', children: String(items.length) })
                          ]
                        })]
                    })
                  }))
                })
          ]
        }),
        showExportOverlay ? 
        // Export Gallery View
        jsx('div', {
          style: { 
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: '#36393F',
            zIndex: 100,
            display: 'grid', 
            gridTemplateRows: 'auto 1fr',
            overflow: 'hidden'
          },
          children: [
            // Header
            jsx('div', {
              style: { 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '15px 20px',
                background: '#23272A',
                borderBottom: '1px solid #444'
              },
              children: [
                jsx('h2', { style: { margin: 0, color: '#fff', fontSize: '18px' }, children: 'Download images' }),
                jsx('div', {
                  children: [
                    jsx('button', {
                      style: { background: '#5865F2', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 16px', cursor: 'pointer', marginRight: '10px', fontSize: '14px' },
                      onClick: handleDownloadAllZip,
                      children: 'All as ZIP'
                    }),
                    jsx('button', {
                      style: { background: '#23272A', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '8px 16px', cursor: 'pointer', fontSize: '14px' },
                      onClick: () => setShowExportOverlay(false),
                      children: 'Back'
                    })
                  ]
                })
              ]
            }),
            // Image grid
            jsx('div', {
              style: { 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', 
                gap: '12px', 
                padding: '20px',
                overflowY: 'auto'
              },
              children: filteredImages.map(img => jsx('div', {
                key: img.id,
                style: { 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center', 
                  background: '#23272A', 
                  borderRadius: 8, 
                  padding: 12, 
                  border: '1px solid #444' 
                },
                children: [
                  jsx('img', { 
                    src: img.src || ensureObjectURL(img),
                    alt: img.name,
                    style: { width: '100%', height: 120, objectFit: 'cover', borderRadius: 4, marginBottom: 8 } 
                  }),
                  jsx('span', { 
                    style: { fontSize: '0.85rem', textAlign: 'center', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', color: '#fff' }, 
                    children: img.name || `Image ${img.id}` 
                  }),
                  jsx('button', {
                    style: { background: '#5865F2', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: '0.85rem', width: '100%' },
                    onClick: () => handleDownloadImage(img),
                    children: 'Download'
                  })
                ]
              }))
            })
          ]
        }) : null
      ]
    })
  }

  function ImageComponent({ item, onSelect, contextMenuObj, setImages, index, categories, onCategoryChange }) {
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const wrapperRef = useRef(null);
    
    const handleImageClick = useCallback(() => {
      previewTimer.current && clearTimeout(previewTimer.current);
      previewTimer.current = null;
      onSelect(item.id);
      viewTransition.setImage(item.src);
      viewTransition.commitPreview?.();
    }, [onSelect, item.id, item.src]);

    /* Live-Vorschau mit Absichts-Verzoegerung: erst nach 450ms Verweilen wird
       das Bild gezeigt. Ohne die Verzoegerung wuerde jedes Ueberstreichen des
       Rasters eine Kaskade von Bildwechseln ausloesen. */
    const previewTimer = useRef(null);
    const handlePreviewEnter = useCallback(() => {
      previewTimer.current && clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => viewTransition.previewImage?.(item.src), 450);
    }, [item.src]);
    const handlePreviewLeave = useCallback(() => {
      previewTimer.current && clearTimeout(previewTimer.current);
      previewTimer.current = null;
      viewTransition.endPreview?.();
    }, []);
    // Beim Ausbauen aufraeumen, sonst bliebe die Vorschau haengen, wenn das
    // Fenster waehrend eines Hovers geschlossen wird.
    useEffect(() => () => {
      previewTimer.current && clearTimeout(previewTimer.current);
      viewTransition.endPreview?.();
    }, []);
    const handleDelete = useCallback(e => {
      e.stopPropagation();
      clearObjectURL(item);
      setImages(prev => prev.filter(e => e.id !== item.id).map((e, i) => { e.id = i + 1; return e; }));
      item.selected && viewTransition.removeImage();
    }, [setImages, item.id, item.selected, item.src]);
    const handleToggleFavorite = useCallback(e => {
      e.stopPropagation();
      setImages(prev => prev.map(img => img.id === item.id ? { ...img, favorite: !img.favorite } : img));
    }, [setImages, item.id]);
    const handleContextMenu = useCallback(e => {
      const ImageContextMenu = ContextMenu.buildMenu([
        contextMenuObj.lazyCarousel ? {
          label: "View image",
          action: () => contextMenuObj.lazyCarousel(item)
        } : undefined,
        ...contextMenuObj.saveAndCopy(item),
        { type: 'separator' },
        {
          label: "Category",
          type: 'submenu',
          items: categories.map(cat => ({
            label: cat,
            type: 'radio',
            checked: (item.category || FALLBACK_CATEGORY) === cat,
            action: () => {
              onCategoryChange(item.id, cat);
              // Menü sofort schließen und neu öffnen, damit checked-State direkt sichtbar ist
              setTimeout(() => {
                ContextMenu.close();
                ContextMenu.open(e, ContextMenu.buildMenu([
                  contextMenuObj.lazyCarousel ? {
                    label: "View image",
                    action: () => contextMenuObj.lazyCarousel(item)
                  } : undefined,
                  ...contextMenuObj.saveAndCopy(item),
                  { type: 'separator' },
                  {
                    label: "Category",
                    type: 'submenu',
                    items: categories.map(cat2 => ({
                      label: cat2,
                      type: 'radio',
                      checked: (cat === cat2),
                      action: () => {}
                    }))
                  }
                ].filter(Boolean)));
              }, 50);
            }
          }))
        }
      ].filter(Boolean));
      ContextMenu.open(e, ImageContextMenu)
    }, [item, contextMenuObj, categories, onCategoryChange]);

    // Drag & Drop Handler für Sortierung
    const handleDragStart = useCallback(e => {
      setIsDragging(true);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }, [index]);
    const handleDragEnd = useCallback(() => {
      setIsDragging(false);
    }, []);
    const handleDragOver = useCallback(e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setIsDragOver(true);
    }, []);
    const handleDragLeave = useCallback(() => {
      setIsDragOver(false);
    }, []);
    const handleDrop = useCallback(e => {
      e.preventDefault();
      setIsDragOver(false);
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (fromIndex !== index && !isNaN(fromIndex)) {
        setImages(prev => {
          const newItems = [...prev];
          const [movedItem] = newItems.splice(fromIndex, 1);
          newItems.splice(index, 0, movedItem);
          return newItems.map((e, i) => { e.id = i + 1; return e; });
        });
      }
    }, [index, setImages]);

    useEffect(() => {
      let first = true;
      const img = new Image();
      img.src = item.src || '';
      img.onload = () => {
        setLoaded(true);
        if (!item.height && !item.width) {
          setImages(prev => {
            const loadedItem = prev.find(e => e.id === item.id);
            loadedItem.width = img.width;
            loadedItem.height = img.height;
            return [...prev];
          });
        }
      };
      img.onerror = () => {
        if (first) {
          clearObjectURL(item);
          setObjectURL(item, item.image);
          img.src = item.src;
          first = false;
        }
        else {
          setError(true);
          setLoaded(true);
        }
      };
    }, []);

    return jsx(constants.nativeUI.FocusRing, null,
      jsx('div', {
        ref: wrapperRef,
        className: 'BackgroundManager-imageWrapper' + (item.selected ? ' selected' : '') + (isDragging ? ' dragging' : '') + (isDragOver ? ' drag-over' : ''),
        onClick: handleImageClick,
        onMouseEnter: handlePreviewEnter,
        onMouseLeave: handlePreviewLeave,
        onContextMenu: handleContextMenu,
        draggable: "true",
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
        children: [
            !loaded ? jsx(constants.nativeUI.Spinner) : error ? jsx('div', { className: constants.textStyles?.defaultColor }, 'Image could not be loaded') : jsx('img', {
            tabIndex: '-1',
            src: item.src || '',
            className: 'BackgroundManager-image',
          }), !error ? jsx(Fragment, {
            children: [
              jsx('div', {
                className: 'BackgroundManager-imageData',
                'data-size': formatNumber(item.image.size),
                'data-dimensions': item.width && item.height ? item.width + ' x ' + item.height : null,
                'data-mime': item.image.type?.split('/').pop().toUpperCase() || null,
              })
            ]
          }) : null, jsx(IconButton, {
            TooltipProps: { text: item.favorite ? 'Remove favorite' : 'Mark as favorite' },
            ButtonProps: {
              onClick: handleToggleFavorite,
              className: 'BackgroundManager-favoriteButton' + (item.favorite ? ' active' : ''),
            },
            SvgProps: {
              width: '16', height: '16',
              path: item.favorite 
                ? "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"
                : "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"
            }
          }), jsx(IconButton, {
            TooltipProps: { text: 'Delete image' },
            ButtonProps: {
              onClick: handleDelete,
              className: 'BackgroundManager-deleteButton',
            },
            SvgProps: {
              width: '16', height: '16',
              path: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            }
          })
        ]
      })
    )
  }

  function InputComponent({ setImages, currentCategory }) {
    const [processing, setProcessing] = useState([]);
    const dropArea = useRef(null);

    const handleFileTransfer = useCallback(async (blob) => {
      // Optimize newly uploaded images before creating object URL
      const filename = blob?.name;
      const optimized = await optimizeNewUpload(blob, filename);
      const img = new Image();
      img.onload = () => setImages(prev => [...prev, { id: prev.length + 1, image: optimized, width: img.width, height: img.height, selected: false, src: img.src, category: currentCategory || FALLBACK_CATEGORY }]);
      img.onerror = () => clearObjectURL(img);
      setObjectURL(img, optimized);
    }, [setImages, currentCategory]);
    const handleUpload = useCallback(() => {
      DiscordNative.fileManager.openFiles({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Alle Bilder', extensions: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'exif', 'bmp', 'dib', 'rle', 'gif', 'avif', 'webp', 'svg', 'ico'] },
          { name: 'PNG', extensions: ['png'] },
          { name: 'JPEG', extensions: ['jpg', 'jpeg', 'jpe', 'jfif', 'exif'] },
          { name: 'BMP', extensions: ['bmp', 'dib', 'rle'] },
          { name: 'GIF', extensions: ['gif'] },
          { name: 'AV1 (AVIF)', extensions: ['avif'] },
          { name: 'WebP', extensions: ['webp'] },
          { name: 'SVG', extensions: ['svg'] },
          { name: 'ICO', extensions: ['ico'] },
        ]
      }).then(files => {
        if (!files.length) return;
        files.forEach(file => {
          if (!file.data || !['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'exif', 'bmp', 'dib', 'rle', 'gif', 'avif', 'webp', 'svg', 'ico'].includes(file.filename?.split('.').pop()?.toLowerCase())) {
            console.warn('Could not upload ' + file.filename + '. Data is empty or ' + file.filename + ' is not an image.');
            return UI.showToast('Could not upload ' + file.filename + '. Data is empty or not an image format.', { type: 'error' });
          }
          handleFileTransfer(new Blob([file.data], { type: getImageType(file.data) }));
        });
      }).catch(e => { console.error(e); UI.showToast('Image could not be uploaded. ' + e, { type: 'error' }) });
    }, [setImages]);
    const handleInput = useCallback(e => {
      e.preventDefault?.();
      e.target.textContent = '';
    }, []);
    const handleDragEnter = useCallback(() => {
      dropArea.current.classList.add('dragging');
    }, [dropArea.current]);
    const handleDragOver = useCallback(e => {
      e.preventDefault?.();
      e.stopPropagation?.();
      e.dataTransfer.dropEffect = 'copy';
    }, []);
    const handleDragEnd = useCallback(() => {
      dropArea.current.classList.remove('dragging');
    }, [dropArea.current]);
    const handleDrop = useCallback(e => {
      const timeStamp = Date.now();
      handleDragEnd();
      if (e.dataTransfer?.files?.length) {
        setProcessing(prev => [...prev, timeStamp]);
        for (const droppedFile of e.dataTransfer.files) {
          handleFileTransfer(droppedFile);
        }
        setProcessing(prev => prev.filter(t => t !== timeStamp));
      } else if (e.dataTransfer?.getData('URL')) {
        setProcessing(prev => [...prev, timeStamp]);
        fetch(e.dataTransfer.getData('URL')).then(async response => {
          return response.ok ? response : Promise.reject(response.status);
        }).then(res =>
          res.headers.get('Content-Type').startsWith('image/') ?
            res.blob() :
            Promise.reject('Dropped item is not an image.')
        ).then(handleFileTransfer).catch(err => {
          UI.showToast('Image data could not be fetched. ' + err, { type: 'error' });
          console.error('Status: ', err)
        }).finally(() => {
          setProcessing(prev => prev.filter(t => t !== timeStamp));
        });
      }
    }, [handleFileTransfer, handleDragEnd, setProcessing]);
    const handlePaste = useCallback(e => {
      e.preventDefault?.();
      const timeStamp = Date.now();
      setProcessing(prev => [...prev, timeStamp]);
      let items = e.clipboardData.items;
      for (let index in items) {
        let item = items[index];
        if (item.kind === 'file') {
          handleFileTransfer(item.getAsFile());
          break;
        }
      }
      setProcessing(prev => prev.filter(t => t !== timeStamp));
    }, [handleFileTransfer, setProcessing]);
    const handleRemove = useCallback(() => {
      setImages(prev => {
        prev.forEach(e => {
          e.selected = false;
        });
        viewTransition.removeImage();
        return [...prev];
      });
    }, [setImages]);

    useEffect(() => { dropArea.current.focus() }, []);

    return jsx('div', {
      className: 'BackgroundManager-inputWrapper',
      children: [
        jsx(constants.nativeUI.FocusRing, null, jsx('div', {
          className: 'BackgroundManager-DropAndPasteArea',
          role: 'button',
          tabIndex: 0,
          contentEditable: 'true',
          ref: dropArea,
          onClick: handleUpload,
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleUpload(); } },
          onInput: handleInput,
          onDrop: handleDrop,
          onPaste: handlePaste,
          onDragOver: handleDragOver,
          onDragEnter: handleDragEnter,
          onDragEnd: handleDragEnd,
          onDragLeave: handleDragEnd,
          children: processing.length ? jsx(constants.nativeUI.Spinner) : null
        })),
        // settings moved to quick-button row
      ]
    })
  }

  function PopoutComponent() {
    const [open, setOpen] = useState(false);
    const targetElementRef = useRef(null);
    const handleClick = useCallback(() => {
      setOpen(op => !op);
    }, [setOpen]);

    return jsx(constants.nativeUI.Popout, {
      shouldShow: open,
      animation: '1',
      position: 'bottom',
      align: 'right',
      autoInvert: false,
      spacing: 8,
      targetElementRef,
      renderPopout: () => jsx(ManagerComponent, { onRequestClose: () => setOpen(false) }),
      children: (e, t) => {
        return jsx(IconComponent, {
          ...e,
          id: meta.slug,
          onClick: handleClick,
          showTooltip: !t.isShown,
          ref: targetElementRef
        })
      }
    })
  }

  function IconButton({ TooltipProps, ButtonProps, SvgProps }) {
    const { component = 'button', ...buttonRestProps } = ButtonProps;
    const { path = '', ...svgRestProps } = SvgProps;
    return jsx(constants.nativeUI.Tooltip, {
      spacing: 8,
      position: 'top',
      color: 'primary',
      hideOnClick: true,
      ...TooltipProps,
      children: ({ onContextMenu, ...restProp }) => jsx(constants.nativeUI.FocusRing, {
        children: jsx(component, {
          ...restProp,
          ...buttonRestProps,
          children: jsx('svg', {
            x: '0', y: '0',
            focusable: 'false',
            'aria-hidden': 'true',
            role: 'img',
            xmlns: "http://www.w3.org/2000/svg",
            width: "24",
            height: "24",
            fill: "none",
            viewBox: "0 0 24 24",
            children: jsx('path', {
              fill: "currentColor",
              d: path
            }),
            ...svgRestProps,
          })
        })
      })
    })
  }

  // Setting Components
  function BuildSettings() {
    const [setting, setSetting] = useSettings();

    return jsx(Fragment, {
      children: [
        jsx(constants.nativeUI.FormTitle, { children: 'Transitions' }),
        jsx(FormSwitch, {
          value: setting.transition.enabled,
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, enabled: newVal } }));
            viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (newVal ? setting.transition.duration ?? 0 : 0) + 'ms');
          },
        }, 'Enable background transitions'),
        jsx(FormNumberInput, {
          disabled: !setting.transition.enabled,
          min: 1,
          value: setting.transition.duration + '',
          defaultValue: defaultSettings.transition.duration,
          label: 'Transition duration',
          suffix: 'ms',
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, duration: newVal } }));
            viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (setting.transition.enabled ? newVal ?? 0 : 0) + 'ms');
          },
        }),
        jsx(FormSelect, {
          disabled: !setting.transition.enabled,
          label: 'Transition effect',
          value: setting.transition.type || 'fade',
          options: Object.entries(transitionTypes).map(([value, label]) => ({ value, label })),
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, type: newVal } }));
            viewTransition.bgContainer()?.setAttribute('data-transition', newVal);
          },
        }),
        jsx(FormSelect, {
          /* Bewusst NICHT von transition.enabled abhaengig: der Dauereffekt
             liegt permanent auf dem Bild und hat mit dem Wechsel nichts zu tun.
             Er soll auch dann laufen, wenn Uebergaenge ausgeschaltet sind. */
          label: 'Ambient effect',
          value: setting.transition.ambient || 'none',
          options: Object.entries(ambientTypes).map(([value, label]) => ({ value, label })),
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, ambient: newVal } }));
            viewTransition.bgContainer()?.setAttribute('data-ambient', newVal);
          },
        }),
        jsx(FormNumberInput, {
          disabled: (setting.transition.ambient || 'none') === 'none',
          min: 10, max: 600,
          value: setting.transition.ambientSpeed ?? 100,
          defaultValue: defaultSettings.transition.ambientSpeed,
          label: 'Ambient effect speed',
          suffix: '%',
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, ambientSpeed: newVal } }));
            applyAmbientSpeed(newVal);
          },
        }),
        jsx('div', { role: 'separator', className: constants.separator?.separator }),
        jsx(constants.nativeUI.FormTitle, { children: 'Slideshow' }),
        jsx(FormSwitch, {
          value: setting.slideshow.enabled,
          onChange: newVal => {
            setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: newVal } }));
            newVal ? slideShowManager.start() : slideShowManager.stop();
          },
        }, 'Diashow aktivieren'),
        jsx(FormNumberInput, {
          disabled: !setting.slideshow.enabled,
          min: 1,
          value: setting.slideshow.interval / 1000 + '',
          defaultValue: defaultSettings.slideshow.interval / 1000,
          label: 'Change interval',
          suffix: 'sec',
          onChange: newVal => {
            setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, interval: newVal * 1000 } }));
            slideShowManager.start();
          },
        }),
        jsx(FormSwitch, {
          disabled: !setting.slideshow.enabled,
          value: setting.slideshow.shuffle,
          onChange: newVal => setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, shuffle: newVal } })),
        }, 'Shuffle order'),
        // Favoriten-Filter Quick-Button kommt in die Toolbar
        // Multi-category filter: toggle which categories the slideshow should use
        jsx('div', {
          style: { marginBottom: '0.75rem' },
          children: [
            jsx('div', { className: constants.textStyles?.defaultColor, style: { marginBottom: 6 }, children: 'Category filter' }),
            jsx('div', {
              style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
              children: [
                jsx('button', {
                  key: 'all-categories-filter',
                  onClick: () => {
                    setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, categoryFilters: [], categoryFilter: null } }));
                    if (setting.slideshow.enabled) slideShowManager.start();
                  },
                  style: { padding: '6px 10px', borderRadius: 6, background: (!setting.slideshow?.categoryFilters || setting.slideshow.categoryFilters.length === 0) ? 'var(--background-modifier-selected)' : 'transparent', color: (!setting.slideshow?.categoryFilters || setting.slideshow.categoryFilters.length === 0) ? '#fff' : 'var(--text-normal)', border: 'none', cursor: 'pointer' },
                  children: 'All categories'
                }),
                ...setting.categories.map(cat => jsx('button', {
                  key: cat,
                  onClick: () => {
                    setSetting(prev => {
                      const prevFilters = Array.isArray(prev.slideshow?.categoryFilters) ? prev.slideshow.categoryFilters.slice() : (prev.slideshow?.categoryFilter ? [prev.slideshow.categoryFilter] : []);
                      const has = prevFilters.includes(cat);
                      const next = has ? prevFilters.filter(c => c !== cat) : [...prevFilters, cat];
                      return { ...prev, slideshow: { ...prev.slideshow, categoryFilters: next, categoryFilter: next.length === 1 ? next[0] : null } };
                    });
                    if (setting.slideshow.enabled) slideShowManager.start();
                  },
                  style: { padding: '6px 10px', borderRadius: 6, background: (Array.isArray(setting.slideshow?.categoryFilters) && setting.slideshow.categoryFilters.includes(cat)) ? 'var(--background-modifier-selected)' : 'transparent', color: (Array.isArray(setting.slideshow?.categoryFilters) && setting.slideshow.categoryFilters.includes(cat)) ? '#fff' : 'var(--text-normal)', border: 'none', cursor: 'pointer' },
                  children: cat
                }))
              ]
            })
          ]
        }),
        jsx('div', { role: 'separator', className: constants.separator?.separator, style: { marginBottom: "1rem" } }),
        jsx(FormSwitch, {
          value: setting.enableDrop,
          note: "When enabled, the popup is moved in front of Discord's native drop area, allowing images to be dragged and dropped.",
          onChange: newVal => setSetting(prev => ({ ...prev, enableDrop: newVal })),
        }, 'Enable drop area'),
        jsx(FormSwitch, {
          value: setting.overwriteCSS,
          note: "Detects the theme's background CSS variable and overrides it. If no variable is found, the original is kept.",
          onChange: newVal => {
            setSetting(prev => ({ ...prev, overwriteCSS: newVal }));
            newVal ? (themeObserver.start(), viewTransition.setProperty()) : themeObserver.stop();
          },
        }, "Override theme CSS variable"),
        jsx(FormSwitch, {
          value: setting.addContextMenu,
          onChange: newVal => {
            setSetting(prev => ({ ...prev, addContextMenu: newVal }));
            newVal ? contextMenuPatcher.patch() : contextMenuPatcher.unpatch();
          },
        }, 'Add context menu entry on images'),
        jsx('div', { role: 'separator', className: constants.separator?.separator, style: { marginBottom: "1rem" } }),
        jsx(constants.nativeUI.Button, {
          style: { marginLeft: "auto" },
          color: constants.nativeUI.Button?.Colors?.RED || 'red',
          onClick: () => {
            UI.showConfirmationModal(
              "Delete Database",
              "This will delete the entire indexedDB database, including every Image saved on it.\n\nAre you sure you want to delete all your saved images?",
              {
                danger: true,
                confirmText: "Yes, Delete",
                onConfirm: () => {
                  viewTransition.removeImage();
                  slideShowManager.stop();
                  setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: false } }));
                  const deleteReq = indexedDB.deleteDatabase(DATA_BASE_NAME);
                  deleteReq.onblocked = () => UI.showToast("Database could not be deleted right away (a connection is still open). Please restart Discord and try again.", { type: 'warning' });
                  deleteReq.onerror = (ev) => { console.error(ev.target?.error); UI.showToast("Failed to delete the database.", { type: 'error' }); };
                }
              }
            );
          }
        }, "Delete Database")
      ]
    })
  }

  function FormSwitch({ value, onChange, note, disabled, children }) {
    return jsx("div", {
      className: ["BackgroundManager-FormSwitch", constants.textStyles?.defaultColor].filter(Boolean).join(" "),
      children: [
        jsx("label", {
          children: [
            jsx("div", null, children),
            jsx(BdApi.Components.SwitchInput, { value, onChange, disabled }),
          ]
        }),
        note && jsx("span", {
          className: constants.textStyles?.["text-sm/normal"],
          style: { color: "var(--text-secondary)" },
        }, note)
      ]
    })
  }

  function FormNumberInput({ value, onChange, label, suffix, defaultValue, ...restProps }) {
    const [val, setVal] = useState(value + '');
    const lastVal = useRef(value);
    const inputRef = useRef(null);

    const handleChange = useCallback(newVal => { setVal(newVal) }, [setVal]);
    const handleBlur = useCallback(() => {
      lastVal.current = !isNaN(Number(val)) ? Math.max(Number(val), restProps.min ?? Number(val)) : lastVal.current;
      onChange(lastVal.current);
      setVal(lastVal.current + '');
    }, [val, onChange, lastVal.current, setVal]);
    const handleKeyDown = useCallback(e => {
      /* Das Kontextmenue hoert global auf Tastendruecke (Navigation, Schnellsuche).
         Ohne stopPropagation kommt keine Ziffer im Feld an. Escape bleibt
         durchlaessig, damit sich das Menue schliessen laesst. */
      if (e.key !== 'Escape') e.stopPropagation?.();

      e.key === 'Enter' && e.target?.blur?.();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault?.();
          const delta = e.key === 'ArrowUp' ? 1 : -1;
          setVal(newValue => { newValue = (Number(newValue) + delta).toFixed(Math.ceil(Math.abs(Math.log10(Math.abs(restProps.min ?? 1))))); return Math.max(Number(newValue), restProps.min ?? Number(newValue)) + '' });
        }
      }
    }, [setVal]);

    useEffect(() => {
      const ctrl = new AbortController();

      inputRef.current?.addEventListener?.('wheel', e => {
        if (e.deltaY && inputRef.current === document.activeElement) {
          e.preventDefault?.();
          setVal(oldValue => {
            oldValue = (Number(oldValue) - Math.sign(e.deltaY)).toFixed(Math.ceil(Math.abs(Math.log10(Math.abs(restProps.min ?? 1)))));
            return Math.max(Number(oldValue), restProps.min ?? Number(oldValue)) + '';
          });
        }
      }, ctrl);
      inputRef.current?.addEventListener?.("beforeinput", e => {
        if (e.data && /[^0-9e\+\-.]+/.test(e.data)) e.preventDefault?.();
      }, ctrl);

      /* Discords Kontextmenue faengt Maus- und Fokus-Ereignisse ab. React-Handler
         laufen erst in der Bubble-Phase und damit zu spaet, deshalb Capture-Phase
         direkt am Feld - sonst laesst sich nicht einmal hineinklicken. */
      const swallowForMenu = e => e.stopPropagation?.();
      ['mousedown', 'pointerdown', 'mouseup', 'click', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress']
        .forEach(type => inputRef.current?.addEventListener?.(type, swallowForMenu, { capture: true, signal: ctrl.signal }));

      inputRef.current?.addEventListener?.('pointerdown', () => {
        setTimeout(() => inputRef.current?.focus?.(), 0);
      }, ctrl);

      return () => ctrl.abort();
    }, []);

    const TextInputComponent = constants.nativeUI.TextInput || (({value, onChange, inputRef, rows, ...props}) => jsx('input', {
      ref: inputRef,
      value, onChange: e => onChange(e.target.value),
      style: { background: '#1e1f22', color: '#fff', border: '1px solid #4e5058', borderRadius: 4, padding: '2px 6px', boxSizing: 'border-box' },
      ...props
    }));

    return jsx('label', {
      className: 'BackgroundManager-FormNumberInput',
      children: [
        jsx("span", { className: constants.textStyles?.defaultColor }, label ?? ''),
        jsx(TextInputComponent, {
          ...restProps,
          inputRef,
          rows: 1,
          value: val,
          className: 'BackgroundManager-NumberInput',
          onChange: handleChange,
          onBlur: handleBlur,
          onKeyDown: handleKeyDown
        }), suffix ? jsx('span', { className: constants.textStyles?.defaultColor }, suffix) : null,
        /* Zuruecksetzen-Knopf, nur sichtbar bei Abweichung vom Standard. Der Klick
           muss lokalen Textzustand UND Einstellung aktualisieren. */
        defaultValue !== undefined && Number(val) !== Number(defaultValue)
          ? jsx('button', {
              type: 'button',
              className: 'BackgroundManager-ResetButton',
              title: 'Reset to default (' + defaultValue + (suffix ? ' ' + suffix : '') + ')',
              'aria-label': 'Reset to default',
              onClick: e => {
                e.preventDefault?.();
                setVal(defaultValue + '');
                onChange(defaultValue);
              },
              children: '\u21ba'
            })
          : null
      ]
    })
  }

  function FormSelect({ label, value, options, onChange, disabled }) {
    return jsx('label', {
      className: 'BackgroundManager-FormSelect',
      children: [
        jsx("span", { className: constants.textStyles?.defaultColor }, label ?? ''),
        jsx('select', {
          disabled,
          value,
          className: 'BackgroundManager-Select',
          onChange: e => onChange(e.target.value),
          children: options.map(opt => jsx('option', { key: opt.value, value: opt.value }, opt.label))
        })
      ]
    })
  }

  function MenuNumberInput({ value, onChange, defaultValue, ...restProps }) {
    const [textValue, setTextValue, textStateRef] = useStateWithRef(value + '');
    const [sliderValue, setSliderValue, sliderStateRef] = useStateWithRef(value);
    const oldValue = useRef(value);
    const ID = useId();
    const sliderRef = useRef(null);
    const inputRef = useRef(null);

    const handleTextChange = useCallback(newValue => { setTextValue(newValue) }, [setTextValue]);
    const handleSliderChange = useCallback(newValue => {
      newValue = Number(newValue.toFixed(restProps.decimals ?? 0));
      restProps.onSlide?.(newValue);
      setSliderValue(newValue);
    }, [setSliderValue, restProps.onSlide]);

    const onTextCommit = useCallback(() => {
      oldValue.current = !isNaN(Number(textValue)) ? Math.max(Number(textValue), restProps.minValue ?? Number(textValue)) : oldValue.current;
      setTextValue(oldValue.current + '');
      setSliderValue(oldValue.current);
      sliderRef.current?._reactInternals?.stateNode?.setState?.({ value: oldValue.current });
      onChange(oldValue.current);
    }, [onChange, setSliderValue, textValue, setTextValue]);
    const handleKeyDown = useCallback(e => {
      /* Das Kontextmenue hoert global auf Tastendruecke (Navigation, Schnellsuche).
         Ohne stopPropagation kommt keine Ziffer im Feld an. Escape bleibt
         durchlaessig, damit sich das Menue schliessen laesst. */
      if (e.key !== 'Escape') e.stopPropagation?.();

      e.key === 'Enter' && e.target?.blur?.();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault?.();
          const delta = (e.key === 'ArrowUp' ? 10 : -10) * (restProps.decimals ? Math.pow(10, -1 * restProps.decimals) : 0.1);
          setTextValue(val => {
            val = (Number(val) + delta).toFixed(restProps.decimals ?? 0);
            return Math.max(Number(val), restProps.minValue ?? Number(val)) + '';
          });
        }
      }
    }, [setTextValue]);
    const onSliderCommit = useCallback(newValue => {
      const fixedValue = Number(newValue.toFixed(restProps.decimals ?? 0));
      setTextValue(fixedValue + '');
      onChange(fixedValue)
    }, [onChange, setTextValue]);

    useEffect(() => {
      const ctrl = new AbortController();

      inputRef.current?.addEventListener?.('wheel', e => {
        if (e.deltaY) {
          const delta = -10 * Math.sign(e.deltaY) * (restProps.decimals ? Math.pow(10, -1 * restProps.decimals) : 0.1);
          setTextValue(val => {
            val = (Number(val) + delta).toFixed(restProps.decimals ?? 0);
            return Math.max(Number(val), restProps.minValue ?? Number(val)) + '';
          });
        }
      }, ctrl);
      inputRef.current?.addEventListener?.("beforeinput", e => {
        if (e.data && /[^0-9e\+\-.]+/.test(e.data)) e.preventDefault?.();
      }, ctrl);

      /* Discords Kontextmenue faengt Maus- und Fokus-Ereignisse ab. React-Handler
         laufen erst in der Bubble-Phase und damit zu spaet, deshalb Capture-Phase
         direkt am Feld - sonst laesst sich nicht einmal hineinklicken. */
      const swallowForMenu = e => e.stopPropagation?.();
      ['mousedown', 'pointerdown', 'mouseup', 'click', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress']
        .forEach(type => inputRef.current?.addEventListener?.(type, swallowForMenu, { capture: true, signal: ctrl.signal }));

      inputRef.current?.addEventListener?.('pointerdown', () => {
        setTimeout(() => inputRef.current?.focus?.(), 0);
      }, ctrl);

      return () => {
        ctrl.abort();
        Number(textStateRef.current) != sliderStateRef.current && onChange(sliderStateRef.current);
      }
    }, []);

    const TextInputComponent = constants.nativeUI.TextInput || (({value, onChange, inputRef, rows, ...props}) => jsx('input', {
      ref: inputRef,
      value, onChange: e => onChange(e.target.value),
      style: { background: '#1e1f22', color: '#fff', border: '1px solid #4e5058', borderRadius: 4, padding: '2px 6px', width: '4rem', textAlign: 'right', fontSize: '14px', boxSizing: 'border-box' },
      ...props
    }));
    const MenuSliderControlComponent = constants.nativeUI.MenuSliderControl || (({ initialValue, onValueChange, asValueChanges, minValue, maxValue, disabled, ...props }) => jsx('input', {
      type: 'range', min: minValue, max: maxValue, defaultValue: initialValue, disabled,
      onChange: e => { const v = Number(e.target.value); asValueChanges?.(v); onValueChange?.(v); },
      style: { width: '100%' },
      ...props
    }));

    return jsx('div', {
      style: {
        display: 'grid', gap: "0.5rem", maxWidth: '16rem'
      },
      className: [constants.separator?.item, constants.separator?.labelContainer, (restProps.disabled ? constants.separator?.disabled : '')].join(' '),
      children: [
        jsx('div', {
          className: constants.textStyles?.defaultColor,
          style: { display: 'flex', gap: '0.25rem', alignItems: 'center' },
          // Fokus gehoert an den Klick, nicht an den Mauszeiger
          onMouseDown: e => e.stopPropagation?.(),
          onClick: e => e.stopPropagation?.(),
          children: [
            jsx('label', {
              htmlFor: ID,
              children: restProps.label,
              style: {
                marginRight: 'auto', paddingRight: '0.75rem',
                cursor: 'inherit',
                flex: '1 0 calc(55% - .5rem)'
              },
              className: [constants.separator?.label].join(' '),
            }),
            /* Derselbe Knopf wie im Einstellungsfenster. Steht bewusst VOR dem
               Eingabefeld, damit er beim Ein- und Ausblenden die Zahl nicht
               seitlich verschiebt. */
            defaultValue !== undefined && Number(textValue) !== Number(defaultValue)
              ? jsx('button', {
                  type: 'button',
                  className: 'BackgroundManager-ResetButton',
                  title: 'Reset to default (' + defaultValue + ')',
                  'aria-label': 'Reset to default',
                  disabled: restProps.disabled,
                  onClick: e => {
                    e.preventDefault?.();
                    e.stopPropagation?.();
                    setTextValue(defaultValue + '');
                    setSliderValue(defaultValue);
                    sliderRef.current?._reactInternals?.stateNode?.setState?.({ value: defaultValue });
                    onChange(defaultValue);
                  },
                  children: '\u21ba'
                })
              : null,
            jsx(TextInputComponent, {
              inputRef,
              value: textValue,
              rows: 1,
              className: "BackgroundManager-NumberInput",
              disabled: restProps.disabled,
              id: ID,
              onChange: handleTextChange,
              onBlur: onTextCommit,
              onKeyDown: handleKeyDown,
            }),
            restProps.suffix ? jsx('span', { children: restProps.suffix }) : null
          ]
        }), jsx("div", {
          children: jsx(MenuSliderControlComponent, {
            ref: sliderRef,
            mini: true, className: constants.slider?.slider,
            disabled: restProps.disabled,
            initialValue: sliderValue,
            onValueRender: e => Number(e.toFixed(restProps.decimals ?? 0)) + (restProps.suffix ?? ''),
            minValue: restProps.minValue,
            maxValue: restProps.maxValue,
            onValueChange: onSliderCommit,
            asValueChanges: handleSliderChange,
            keyboardStep: restProps.decimals ? Math.pow(10, -1 * restProps.decimals + 1) : 1
          })
        })
      ]
    })
  }

  function InPopoutSettings({ rerender = () => {} }) {
    const [settings, setSettings] = useSettings();
    const handleClick = useCallback(e => {
      const MyContextMenu = ContextMenu.buildMenu([
        { type: 'separator' },
        {
          label: "Enable transition",
          type: 'toggle',
          checked: settings.transition.enabled,
          action: () => {
            setSettings(prev => ({ ...prev, transition: { ...prev.transition, enabled: !prev.transition.enabled } }));
            viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (settings.transition.enabled ? settings.transition.duration ?? 0 : 0) + 'ms');
          }
        }, {
          label: "Transition duration",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            disabled: !settings.transition.enabled,
            label: "Transition duration",
            value: settings.transition.duration,
            minValue: 0, maxValue: 3000,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, duration: Number(newVal) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (settings.transition.enabled ? Number(newVal) ?? 0 : 0) + 'ms');
            },
            suffix: " ms"
          })),
        }, {
          type: 'group',
          items: [{
            label: "Enable slideshow",
            type: 'toggle',
            checked: settings.slideshow.enabled,
            action: () => {
              setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: !prev.slideshow.enabled } }));
              settings.slideshow.enabled ? slideShowManager.stop() : slideShowManager.start();
              rerender(e => [...e]);
            }
          }, {
            label: "Slideshow interval",
            type: "custom",
            render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
              disabled: !settings.slideshow.enabled,
              label: "Slideshow interval",
              value: settings.slideshow.interval / 1000,
              minValue: 1, maxValue: 600,
              decimals: 0,
              onChange: newVal => {
                const oldValue = settings.slideshow.interval;
                setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, interval: Number(newVal) * 1000 } }));
                if (oldValue !== newVal * 1000) slideShowManager.start();
              },
              suffix: " Sek"
            })),
          }, {
            label: "Shuffle order",
            type: 'toggle',
            checked: settings.slideshow.shuffle,
            action: () => setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, shuffle: !prev.slideshow.shuffle } }))
          }]
        }, { type: 'separator', }, {
          /* Untermenue statt <select>: ein natives Dropdown wird vom Betriebssystem
             gezeichnet (kein Theme-Styling moeglich) und schliesst sich, weil das
             Kontextmenue mousedown abfaengt. */
          label: 'Transition effect',
          type: 'submenu',
          items: Object.entries(transitionTypes).map(([value, label]) => ({
            label,
            type: 'radio',
            checked: (settings.transition.type || 'fade') === value,
            action: () => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, type: value } }));
              try { viewTransition.bgContainer()?.setAttribute('data-transition', value); } catch (err) {}
              try { viewTransition.setProperty?.(); } catch (err) {}
              try { UI.showToast('Transition: ' + label, { type: 'success' }); } catch (err) {}
              /* Das Menue wird beim Oeffnen einmal aufgebaut, "checked" ist also eine
                 Momentaufnahme. Deshalb schliessen statt neu zeichnen. */
              try { ContextMenu.close(); } catch (err) {}
            }
          }))
        }, {
          /* Zweite, unabhaengige Auswahl. Der Uebergang bestimmt WIE gewechselt
             wird, der Dauereffekt liegt permanent auf dem Bild - beides frei
             kombinierbar. Frueher steckten beide Arten in derselben Liste,
             weshalb ein "Ken Burns" den Bildwechsel gar nicht beeinflusst hat. */
          label: 'Ambient effect',
          type: 'submenu',
          items: Object.entries(ambientTypes).map(([value, label]) => ({
            label,
            type: 'radio',
            checked: (settings.transition.ambient || 'none') === value,
            action: () => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, ambient: value } }));
              try { viewTransition.bgContainer()?.setAttribute('data-ambient', value); } catch (err) {}
              try { UI.showToast('Ambient effect: ' + label, { type: 'success' }); } catch (err) {}
              try { ContextMenu.close(); } catch (err) {}
            }
          }))
        }, {
          label: 'Ambient effect speed',
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Speed",
            value: settings.transition.ambientSpeed ?? 100,
            defaultValue: defaultSettings.transition.ambientSpeed,
            minValue: 10, maxValue: 600,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, ambientSpeed: newVal } }));
              applyAmbientSpeed(newVal);
            },
            /* onSlide wirkt live beim Ziehen - bewusst nur die CSS-Variable und
               nicht applyAmbientSpeed: die Keyframes waehrend des Ziehens neu zu
               schreiben wuerde die laufende Animation staendig neu starten. */
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-ambient-factor', String(100 / (newVal || 100))),
            suffix: '%'
          })),
        }, { type: 'separator' }, {
          label: 'Dimming',
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Dimming",
            value: settings.adjustment.dimming,
            defaultValue: defaultSettings.adjustment.dimming,
            minValue: 0, maxValue: 1,
            decimals: 2,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, dimming: newVal } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-dimming', newVal);
            },
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-dimming', newVal),
            suffix: ''
          })),
        }, {
          label: "Blur",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Blur",
            value: settings.adjustment.blur,
            defaultValue: defaultSettings.adjustment.blur,
            minValue: 0, maxValue: 100,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, blur: Math.min(100, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-blur', Math.min(100, Math.max(0, newVal)) + 'px');
            },
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-blur', Math.min(100, Math.max(0, newVal)) + 'px'),
            suffix: ' px'
          })),
        }, {
          label: "Grayscale",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Grayscale",
            value: settings.adjustment.grayscale,
            defaultValue: defaultSettings.adjustment.grayscale,
            minValue: 0, maxValue: 100,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, grayscale: Math.min(100, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-grayscale', Math.min(100, Math.max(0, newVal)) + '%');
            },
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-grayscale', Math.min(100, Math.max(0, newVal)) + '%'),
            suffix: ' %'
          })),
        }, {
          label: "Saturation",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Saturation",
            value: settings.adjustment.saturate,
            defaultValue: defaultSettings.adjustment.saturate,
            minValue: 0, maxValue: 300,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, saturate: Math.min(300, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-saturation', Math.min(300, Math.max(0, newVal)) + '%');
            },
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-saturation', Math.min(300, Math.max(0, newVal)) + '%'),
            suffix: ' %'
          })),
        }, {
          label: "Kontrast",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Contrast",
            value: settings.adjustment.contrast,
            defaultValue: defaultSettings.adjustment.contrast,
            minValue: 0, maxValue: 300,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, contrast: Math.min(300, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-contrast', Math.min(300, Math.max(0, newVal)) + '%');
            },
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-contrast', Math.min(300, Math.max(0, newVal)) + '%'),
            suffix: ' %'
          })),
        }
      ]);
      ContextMenu.open(e, MyContextMenu);
    }, [settings]);

    return jsx(IconButton, {
      TooltipProps: { text: 'Open Settings' },
      ButtonProps: {
        className: 'BackgroundManager-SettingsButton',
        onClick: handleClick,
      },
      SvgProps: { path: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6' }
    })
  }

  // Patching functions
  /** Context menu un-/patcher */
  const contextMenuPatcher = function () {
    let cleanupImage, cleanupMessage;
    function patch() {
      if (!cleanupImage) {
        // image modal
        cleanupImage = ContextMenu.patch('image-context', (menu, context) => {
          if (context.target.tagName === 'IMG') {
            menu.props.children.splice(menu.props.children.length, 0, BuildMenuItem(context.src));
          }
        });
      }
      if (!cleanupMessage) {
        cleanupMessage = ContextMenu.patch('message', (menu, context) => {
          let embed;
          if (
            context.target.classList.contains(constants.originalLink?.originalLink) &&
            context.target.dataset.role === 'img' &&
            Array.isArray(menu?.props?.children?.props?.children)
          ) {
            if (context.mediaItem?.contentType?.startsWith('image')) {
              // uploaded image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(context.mediaItem.url))
            } else if ((embed = context.message.embeds?.find(e => e.image?.url === context.target.href))) {
              // linked image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(embed.image.proxyURL))
            } else if ((embed = context.message.messageSnapshots[0].message.embeds?.find(e => e.image?.url === context.target.href))) {
              // forwarded linked image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(embed.image.proxyURL))
            } else if ((embed = context.message.messageSnapshots[0].message.attachments?.find(e => e.url === context.target.href))) {
              // forwarded uploaded image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(embed.proxy_url))
            }
          }
        })
      }
    }
    function unpatch() {
      cleanupImage?.();
      cleanupImage = null;
      cleanupMessage?.();
      cleanupMessage = null;
    }
    function BuildMenuItem(src) {
      return jsx(ContextMenu.Group, null, jsx(ContextMenu.Item, {
        id: 'add-Manager',
        label: 'Add to Background Manager',
        action: async () => {
          let mediaURL = function (src) {
            let safeURL = function (url) { try { return new URL(url) } catch (e) { return null } }(src);
            return null == safeURL || safeURL.host === "cdn.discordapp.com" ? src : safeURL.origin === "https://media.discordapp.net" ? (safeURL.host = "cdn.discordapp.com",
              ["size", "width", "height", "quality", "format"].forEach(param => safeURL.searchParams.delete(param)),
              safeURL.toString()) : (safeURL.searchParams.delete("width"),
                safeURL.searchParams.delete("height"),
                safeURL.toString())
          }(src);
          try {
            const response = await fetch(new Request(mediaURL, { method: "GET", mode: "cors" }));
            if (!response.ok) throw new Error(response.status);
            if (!response.headers.get('Content-Type').startsWith('image/')) throw new Error('Item is not an image.');
            const blub = await response.blob();
            const image = new Image();
            image.onload = () => setImageFromIDB(storedImages => {
              storedImages.push({ id: storedImages.length + 1, image: blub, width: image.width, height: image.height, selected: false, src: null });
              clearObjectURL(image);
              UI.showToast("Successfully added to Background Manager", { type: 'success' });
            });
            image.onerror = () => clearObjectURL(image);
            setObjectURL(image, blub);
          } catch (err) {
            console.error('Status ', err)
            UI.showToast("Could not add. Status " + err, { type: 'error' });
          };
        }, icon: s => jsx('svg', {
          className: s.className,
          'aria-hidden': 'true',
          role: 'img',
          xmlns: "http://www.w3.org/2000/svg",
          width: "16",
          height: "16",
          viewBox: "0 0 24 24",
          children: jsx('path', {
            fill: "currentColor",
            d: "M19 10v7h-12v-12h7v-2h-7c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-7zM10.5 12.67l1.69 2.26 2.48-3.1 3.33 4.17h-10zM1 7v14c0 1.1.9 2 2 2h14v-2H4V7zM21 3v-3h-2v3h-3c.01.01 0 2 0 2h3v2.99c.01.01 2 0 2 0v-2.99h3v-2z"
          })
        })
      }))
    }

    return { patch, unpatch }
  }();

  /** Patches the button to the HeaderBar */
  function addButton() {
    if (constants.settings.addContextMenu) contextMenuPatcher.patch();
    try {
      // patch image Modal to be able to show blobs as well
      const filter2 = m => m instanceof Function && (str => ['"disable-adaptive-theme":'].every(s => str.includes(s)))(m.toString());
      const getSrcModule = Webpack.getModule(m => Object.values(m).some(filter2));
      if (!getSrcModule) throw new Error("Cannot find src module");
      const getSrcKey = Object.keys(getSrcModule).find(key => filter2(getSrcModule[key]));
      if (!getSrcKey) throw new Error("Cannot find src module key");
      Patcher.after(meta.slug, getSrcModule, getSrcKey, (_, args) => {
        if (args[0]?.src?.startsWith?.('blob:'))
          return args[0].src;
      })
    } catch (e) {
      console.error('%c[BackgroundManager]%c ', e, "color:#DBDCA6;font-weight:bold", "")
    }
    // patch headerbar
    try {
      const filter = module => module?.Icon && module.Title && module.toString().includes('section');
      const HeaderBarModule = Webpack.getModule(m => Object.values(m).some(filter));
      if (!HeaderBarModule) throw new Error("Cannot find toolbar module");
      const headerBarKey = Object.keys(HeaderBarModule).find(key => filter(HeaderBarModule[key]));
      if (!headerBarKey) throw new Error("Cannot find toolbar module key");
      Patcher.before(meta.slug, HeaderBarModule, headerBarKey, (_, args) => {
        // Check if toolbar children exists and if its an Array. Also, check if our component is already there.
        if (Array.isArray(args[0]?.toolbar?.props?.children) && !args[0].toolbar.props.children.some?.(e => e?.key === meta.slug))
          // Render the component behind the search bar.
          args[0].toolbar.props.children.splice(-2, 0, jsx(ErrorBoundary, {
            children: jsx(PopoutComponent), key: meta.slug
          }));
      })
    } catch (e) {
      console.error('%c[BackgroundManager] %cCould not patch the HeaderBar - the toolbar icon will not appear, but the rest of the plugin still works. Discord likely changed the internal toolbar module.', "color:#DBDCA6;font-weight:bold", "", e);
    }
    forceRerenderElement('.' + constants.toolbarClasses?.toolbar);
  }

  /** Cleanup when plugin is disabled */
  function stop() {
    // Sonst schlaegt die Update-Pruefung noch zu, nachdem das Plugin aus ist.
    clearTimeout(updateTimer);
    updateTimer = null;

    let db;
    // On unmount, check if there are any selected images inside the database, and if so, revoke the URL and remove URL from the database.
    openDB('images').then(database => {
      db = database;
      return getAllItems(db, 'images');
    }).then(storedItems => {
      storedItems.forEach(e => {
        clearObjectURL(e);
        e.src = null;
      });
      saveItems(db, 'images', storedItems, storedItems);
    }).catch(err => {
      console.error('Error opening database:', err);
    }).finally(() => {
      db?.close();
    });
    // destroy any slideshows, mutation observer and image containers
    slideShowManager.stop();
    themeObserver.stop();
    viewTransition.destroy();
    // remove the icon
    constants.toolbarClasses?.toolbar && forceRerenderElement('.' + constants.toolbarClasses?.toolbar);
    // unpatch contextmenu
    contextMenuPatcher.unpatch();
    // unpatch the toolbar
    Patcher.unpatchAll(meta.slug);
    // remove styles
    DOM.removeStyle(meta.slug + '-style');
    DOM.removeStyle(meta.slug + '-glitch');
    DOM.removeStyle('BackgroundManager-background');
    /* Zwischengespeicherte Zustaende freigeben. _cachedImages haelt sonst alle
       Bilddaten im Speicher, obwohl das Plugin aus ist. */
    constants._cachedImages = null;
    constants._slideshowFavoritesOnly = null;
    constants._slideshowCategoryFilters = null;
  }

  /* ---- Eingebauter ZIP-Schreiber ----
     Keine Fremdbibliothek: die BD-Richtlinien verbieten zur Laufzeit geladene
     Bibliotheken. Kurz bleibt es, weil KEINE Komprimierung noetig ist - Bilder
     sind als WebP, JPEG oder PNG bereits komprimiert. Uebrig bleibt der reine
     Container. Unterordner entstehen durch Schraegstriche im Dateinamen. */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * @param {{name: string, data: Uint8Array}[]} entries
   * @returns {Blob} ZIP-Datei, unkomprimiert gespeichert (Methode 0)
   */
  function createZipBlob(entries) {
    const encoder = new TextEncoder();
    const parts = [];      // Nutzdaten in Reihenfolge
    const central = [];    // Eintraege des Zentralverzeichnisses
    let offset = 0;

    // MS-DOS-Zeitstempel der aktuellen Zeit
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // Signatur
      local.setUint16(4, 20, true);           // benoetigte Version
      local.setUint16(6, 0x0800, true);       // Bit 11: Dateiname ist UTF-8
      local.setUint16(8, 0, true);            // Methode 0 = gespeichert
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); // komprimierte Groesse
      local.setUint32(22, data.length, true); // Originalgroesse
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);           // keine Zusatzfelder

      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);             // erzeugende Version
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, nameBytes.length, true);
      dir.setUint32(42, offset, true);        // Position des Dateikopfs
      central.push(new Uint8Array(dir.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);   // Eintraege auf diesem Datentraeger
    end.setUint16(10, entries.length, true);  // Eintraege insgesamt
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);          // Beginn des Zentralverzeichnisses

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // utility

  /** Wie lange ein einzelner Glitch-Ausbruch dauert - unabhaengig vom Abstand. */
  const GLITCH_BURST_MS = 450;
  /** Grundabstand zwischen zwei Ausbruechen bei Tempo 100%. */
  const GLITCH_BASE_PERIOD_MS = 6000;

  /**
   * Erzeugt die bm-glitch-Keyframes so, dass der Ausbruch immer gleich lang
   * bleibt und sich nur der Abstand davor aendert.
   *
   * Der Trick: Die Animation laeuft ueber die volle Periode, aber der Ausbruch
   * belegt davon nur den hinteren Teil - und zwar genau so viel Prozent, wie
   * GLITCH_BURST_MS an der aktuellen Periode ausmacht. Wird die Periode
   * kuerzer, waechst dieser Prozentanteil entsprechend mit, sodass der
   * Ausbruch in Sekunden gemessen gleich lang bleibt.
   */
  function updateGlitchKeyframes(speed) {
    const periodMs = GLITCH_BASE_PERIOD_MS * (100 / (speed || 100));
    // Bei sehr kurzen Perioden nicht mehr als 60% belegen, sonst geht die
    // Ruhephase verloren und es zuckt durchgehend.
    const burstPct = Math.min(60, Math.max(0.2, (GLITCH_BURST_MS / periodMs) * 100));
    const start = 100 - burstPct;
    const at = fraction => (start + burstPct * fraction).toFixed(3);

    DOM.addStyle(meta.slug + '-glitch', `
@keyframes bm-glitch {
  0%, ${start.toFixed(3)}% { transform: none; filter: none; }
  ${at(0.15)}% { transform: translate3d(-7px, 0, 0); filter: saturate(1.5) hue-rotate(8deg); }
  ${at(0.45)}% { transform: translate3d(6px, -2px, 0); filter: saturate(0.7); }
  ${at(0.70)}% { transform: translate3d(-3px, 1px, 0); filter: none; }
  ${at(1)}%, 100% { transform: none; filter: none; }
}`);
  }

  /** Setzt Tempo-Variable und passende Glitch-Keyframes in einem Rutsch. */
  function applyAmbientSpeed(speed) {
    const value = speed || 100;
    viewTransition.bgContainer()?.style.setProperty('--BgManager-ambient-factor', String(100 / value));
    updateGlitchKeyframes(value);
  }

  /** Generates the main CSS for the plugin */
  function generateCSS() {
    DOM.removeStyle(meta.slug + '-style');
    DOM.addStyle(meta.slug + '-style', `
/* Chips: beschriftete Schalter fuer Zustaende und haeufige Aktionen.
   Der aktive Zustand ist am helleren Rand und Hintergrund erkennbar - genau
   das fehlte den nackten Icons. */
.BackgroundManager-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.03);
  color: var(--interactive-normal, rgba(255, 255, 255, 0.72));
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
}

.BackgroundManager-chip:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.18);
  color: var(--interactive-active, #fff);
}

.BackgroundManager-toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0;
}

.BackgroundManager-toolRow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* Die Ueberschrift links macht den Bezug klar. "Favorites" allein sagt nicht,
   ob damit gefiltert, markiert oder geloescht wird. Feste Breite, damit beide
   Zeilen an derselben Kante beginnen. */
.BackgroundManager-toolLabel {
  flex: 0 0 auto;
  width: 76px;
  font-size: 11px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  /* Ohne nowrap bricht "SLIDESHOW" bei 68px in zwei Zeilen um. */
  white-space: nowrap;
  color: var(--text-muted, rgba(255, 255, 255, 0.38));
  user-select: none;
}

/* Ueberlaufmenue und Einstellungen als eigene Gruppe ganz rechts. */
.BackgroundManager-toolEnd {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding-left: 12px;
}

.BackgroundManager-iconButton,
.BackgroundManager-toolEnd .BackgroundManager-quickButton,
.BackgroundManager-toolEnd > button {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid transparent;
  background: none;
  color: var(--interactive-normal, rgba(255, 255, 255, 0.6));
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
}

.BackgroundManager-iconButton:hover,
.BackgroundManager-toolEnd > button:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.14);
  color: var(--interactive-active, #fff);
}

.BackgroundManager-chip.amber {
  border-color: rgba(250, 166, 26, 0.45);
  background: rgba(250, 166, 26, 0.10);
  color: #faa61a;
  box-shadow: 0 0 10px 0 rgba(250, 166, 26, 0.18);
}

.BackgroundManager-chip.active {
  border-color: rgba(255, 215, 0, 0.45);
  background: rgba(255, 215, 0, 0.10);
  color: #ffd700;
  box-shadow: 0 0 10px 0 rgba(255, 215, 0, 0.18);
}

/* Kachel hebt sich beim Ueberfahren leicht an. Bewegung erzeugt mehr
   Wertigkeit als jeder Schein - und transform kostet nichts, weil es
   ausschliesslich auf der GPU laeuft. */
.BackgroundManager-categoryStack {
  padding: 6px 6px 2px;
  border-radius: 12px;
  transition: transform 180ms cubic-bezier(0.22,0.61,0.36,1), background-color 180ms ease;
}

/* Nur Anheben, keine Hintergrundflaeche - der Rahmen wirkte unruhig. */
.BackgroundManager-categoryStack:hover {
  transform: translateY(-3px);
}

/* Die Kategorie, aus der das aktuell laufende Bild stammt. Beantwortet auf
   der Uebersicht die Frage "wo laeuft es gerade her?", ohne ein einziges
   zusaetzliches Bedienelement. */
.BackgroundManager-categoryStack.has-active .BackgroundManager-categoryName::after {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 7px;
  vertical-align: middle;
  border-radius: 50%;
  background: #ff5abe;
  box-shadow: 0 0 8px 2px rgba(255, 90, 190, 0.6);
}

.BackgroundManager-categoryStack.has-active img:last-of-type {
  outline: 1px solid rgba(255, 255, 255, 0.30);
  outline-offset: -1px;
}

/* Die Karten bekommen ihren Schatten per Inline-Style aus dem JSX, und
   Inline-Styles schlagen jedes Stylesheet - daher !important. */
.BackgroundManager-categoryStack:hover img {
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45),
              0 0 16px 0 rgba(255, 255, 255, 0.14) !important;
}

/* Drop-Zone reagiert, sobald eine Datei darueber gezogen wird. Das ist
   gleichzeitig echtes Feedback ("hier kannst du loslassen") und die Stelle,
   an der ein Leuchten wirklich etwas aussagt statt nur zu dekorieren. */
.BackgroundManager-DropAndPasteArea:is(:hover, .dragging) {
  border-color: rgba(255, 255, 255, 0.32);
  background: rgba(255, 255, 255, 0.05);
  box-shadow: 0 0 18px 0 rgba(255, 255, 255, 0.10),
              inset 0 0 22px 0 rgba(255, 255, 255, 0.05);
}

/* Feine Lichtkante an der Oberkante des Fensters. Kein Glow im engeren Sinn,
   aber genau das, was Glasoberflaechen hochwertig wirken laesst. */
.BackgroundManager-popoutInner {
  position: relative;
}

.BackgroundManager-popoutInner::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 2;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.16) 18%,
    rgba(255, 255, 255, 0.16) 82%,
    transparent 100%);
}

.BackgroundManager-ResetButton {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--interactive-normal, rgba(255,255,255,0.55));
  transition: color 120ms ease, background-color 120ms ease;
}
.BackgroundManager-ResetButton:hover {
  color: var(--interactive-active, #fff);
  background: var(--background-modifier-hover, rgba(255,255,255,0.08));
}
.BackgroundManager-ResetButton:disabled {
  opacity: 0.4;
  cursor: default;
}
.BackgroundManager-NumberInput::-webkit-scrollbar {
  display: none;
}
#app-mount .${constants.baseLayer.bg} {
  isolation: isolate;
  display: block;
}
.BackgroundManager-bgContainer {
  position: absolute;
  inset: 0;
  z-index: -1;
  isolation: isolate;
}
.BackgroundManager-bgContainer::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(var(--BgManager-blur, 0px));
}
.BackgroundManager-bg {
  position: absolute;
  inset: 0;
  opacity: 0;
  background: calc(50% - var(--BgManager-position-x, 0%)) calc(50% - var(--BgManager-position-y, 0%)) / cover no-repeat fixed;
  filter: grayscale(var(--BgManager-grayscale, 0%)) contrast(var(--BgManager-contrast, 100%)) saturate(var(--BgManager-saturation, 100%));
  mix-blend-mode: plus-lighter;
  transition: var(--BgManager-transition-duration, 0ms) ease-out;
  transition-property: opacity, transform, filter;
  transform: scale(1) translateX(0);
}
.BackgroundManager-bg.active {
  opacity: 1;
}
/* ============================================================================
   ÜBERGÄNGE  (data-transition, laufen EINMAL beim Bildwechsel)
   ----------------------------------------------------------------------------
   Alle nutzen --BgManager-transition-duration, respektieren also die
   eingestellte Dauer. Sie liegen auf .BackgroundManager-bg, den beiden
   Bildebenen. Dauereffekte liegen dagegen auf dem Container - so kommen sich
   die beiden transform-Ketten nicht in die Quere.
   ========================================================================= */

.BackgroundManager-bgContainer[data-transition="fade"] .BackgroundManager-bg {
  transition-property: opacity;
}

.BackgroundManager-bgContainer[data-transition="slide"] .BackgroundManager-bg {
  transform: translateX(-100%);
}
.BackgroundManager-bgContainer[data-transition="slide"] .BackgroundManager-bg.active {
  transform: translateX(0);
}

.BackgroundManager-bgContainer[data-transition="slideup"] .BackgroundManager-bg {
  transform: translateY(100%);
}
.BackgroundManager-bgContainer[data-transition="slideup"] .BackgroundManager-bg.active {
  transform: translateY(0);
}

.BackgroundManager-bgContainer[data-transition="zoom"] .BackgroundManager-bg {
  transform: scale(1.25);
}
.BackgroundManager-bgContainer[data-transition="zoom"] .BackgroundManager-bg.active {
  transform: scale(1);
}

.BackgroundManager-bgContainer[data-transition="zoomout"] .BackgroundManager-bg {
  transform: scale(0.75);
}
.BackgroundManager-bgContainer[data-transition="zoomout"] .BackgroundManager-bg.active {
  transform: scale(1);
}

/* Die Filter-Kette wird komplett neu geschrieben, weil filter keine einzelnen
   Funktionen ueberschreiben kann. Die Regler-Variablen muessen deshalb mit. */
.BackgroundManager-bgContainer[data-transition="blur"] .BackgroundManager-bg {
  filter: grayscale(var(--BgManager-grayscale, 0%)) contrast(var(--BgManager-contrast, 100%)) saturate(var(--BgManager-saturation, 100%)) blur(24px);
}
.BackgroundManager-bgContainer[data-transition="blur"] .BackgroundManager-bg.active {
  filter: grayscale(var(--BgManager-grayscale, 0%)) contrast(var(--BgManager-contrast, 100%)) saturate(var(--BgManager-saturation, 100%)) blur(0px);
}

/* Drehen plus Zoom. Ein echter Wuerfel braeuchte zwei Flaechen mit
   preserve-3d, es gibt aber nur eine Ebene. */
.BackgroundManager-bgContainer[data-transition="spin"] .BackgroundManager-bg {
  transform: rotate(-14deg) scale(1.4);
}
.BackgroundManager-bgContainer[data-transition="spin"] .BackgroundManager-bg.active {
  transform: rotate(0deg) scale(1);
}

/* Oeffnet aus der Mitte. transition-property muss opacity mitfuehren, sonst
   verschwindet das alte Bild schlagartig. */
.BackgroundManager-bgContainer[data-transition="curtain"] .BackgroundManager-bg {
  clip-path: inset(0 50% 0 50%);
  transition-property: opacity, clip-path;
}
.BackgroundManager-bgContainer[data-transition="curtain"] .BackgroundManager-bg.active {
  clip-path: inset(0 0 0 0);
}

/* clip-path statt Maske: exakt, und nutzt die eingestellte Dauer. */
.BackgroundManager-bgContainer[data-transition="wipe"] .BackgroundManager-bg {
  clip-path: inset(0 100% 0 0);
  transition-property: opacity, clip-path;
}
.BackgroundManager-bgContainer[data-transition="wipe"] .BackgroundManager-bg.active {
  clip-path: inset(0 0 0 0);
}

/* Neu: Blende, wie bei einer Kamera. */
.BackgroundManager-bgContainer[data-transition="iris"] .BackgroundManager-bg {
  clip-path: circle(0% at 50% 50%);
  transition-property: opacity, clip-path;
}
.BackgroundManager-bgContainer[data-transition="iris"] .BackgroundManager-bg.active {
  clip-path: circle(80% at 50% 50%);
}


/* ============================================================================
   DAUEREFFEKTE  (data-ambient, laufen DURCHGEHEND auf dem aktuellen Bild)
   ----------------------------------------------------------------------------
   Bewusst auf dem Container statt auf den Bildebenen: sonst wuerde ihr
   transform mit dem des Uebergangs kollidieren. So laesst sich jeder
   Dauereffekt frei mit jedem Uebergang kombinieren.
   ========================================================================= */

/* TEMPO: --BgManager-ambient-factor ist ein Multiplikator auf die Dauer.
   Er wird aus dem Regler berechnet: Faktor = 100 / Tempo.
   Also 100% = Grunddauer, 200% = doppelt so schnell, 50% = halb so schnell.
   calc() darf <time> mit einer Zahl multiplizieren - so wirkt ein einziger
   Regler auf alle Dauereffekte, ohne dass jeder eigene Werte braucht. */
.BackgroundManager-bgContainer[data-ambient="kenburns"] {
  animation: bm-kenburns calc(40s * var(--BgManager-ambient-factor, 1)) ease-in-out infinite;
}
@keyframes bm-kenburns {
  0%   { transform: scale(1.06) translate3d(0, 0, 0); }
  50%  { transform: scale(1.14) translate3d(-2.5%, -1.8%, 0); }
  100% { transform: scale(1.06) translate3d(0, 0, 0); }
}

/* transform statt background-position: laesst die X/Y-Regler in Ruhe und
   ist deutlich guenstiger. */
.BackgroundManager-bgContainer[data-ambient="drift"] {
  animation: bm-drift calc(26s * var(--BgManager-ambient-factor, 1)) ease-in-out infinite;
}
@keyframes bm-drift {
  0%   { transform: scale(1.05) translate3d(-1.2%, 0, 0); }
  50%  { transform: scale(1.05) translate3d(1.2%, -0.8%, 0); }
  100% { transform: scale(1.05) translate3d(-1.2%, 0, 0); }
}

.BackgroundManager-bgContainer[data-ambient="pulse"] {
  animation: bm-pulse calc(14s * var(--BgManager-ambient-factor, 1)) ease-in-out infinite;
}
@keyframes bm-pulse {
  0%, 100% { transform: scale(1.02); filter: brightness(1); }
  50%      { transform: scale(1.05); filter: brightness(1.08); }
}

/* Gelegentlicher Ruck, kein Dauerzucken. */
.BackgroundManager-bgContainer[data-ambient="glitch"] {
  animation: bm-glitch calc(6s * var(--BgManager-ambient-factor, 1)) steps(1) infinite;
}
/* Die Keyframes fuer bm-glitch stehen NICHT hier, sondern werden von
   updateGlitchKeyframes() erzeugt und als eigenes <style> eingehaengt.
   Grund: Keyframe-Marken sind Prozentwerte, also Anteile der Gesamtdauer.
   Wird der Abstand zwischen zwei Glitches kuerzer, schrumpft damit auch der
   Ausbruch selbst - er wird also schneller statt nur haeufiger. Genau das
   soll nicht passieren. CSS kann Prozentwerte nicht aus einer Variablen
   rechnen, deshalb macht es JavaScript. */

/* Koernung und Scanlines liegen auf ::before. ::after ist schon vom
   Hintergrund-Blur belegt. z-index hebt sie ueber die Bildebenen. */
.BackgroundManager-bgContainer[data-ambient="grain"]::before,
.BackgroundManager-bgContainer[data-ambient="scanlines"]::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

/* Deckkraft bewusst hoch genug, um wahrgenommen zu werden. */
.BackgroundManager-bgContainer[data-ambient="grain"]::before {
  background-image:
    radial-gradient(rgba(255,255,255,0.55) 0.5px, transparent 0.6px),
    radial-gradient(rgba(0,0,0,0.45) 0.5px, transparent 0.6px);
  background-size: 3px 3px, 4px 4px;
  background-position: 0 0, 1px 2px;
  opacity: 0.16;
  mix-blend-mode: overlay;
  animation: bm-grain calc(0.7s * var(--BgManager-ambient-factor, 1)) steps(4) infinite;
}
@keyframes bm-grain {
  0%   { background-position: 0 0, 1px 2px; }
  25%  { background-position: 1px 2px, 2px 0; }
  50%  { background-position: 2px 1px, 0 1px; }
  75%  { background-position: 0 2px, 2px 2px; }
  100% { background-position: 0 0, 1px 2px; }
}

.BackgroundManager-bgContainer[data-ambient="scanlines"]::before {
  background-image: repeating-linear-gradient(
    to bottom,
    rgba(0,0,0,0.22) 0 1px,
    transparent 1px 3px
  );
  opacity: 0.5;
  animation: bm-scanroll calc(8s * var(--BgManager-ambient-factor, 1)) linear infinite;
}
@keyframes bm-scanroll {
  0%   { background-position-y: 0; }
  100% { background-position-y: 3px; }
}

/* Wer Bewegung nicht mag, bekommt die Dauereffekte ohne Animation. */
@media (prefers-reduced-motion: reduce) {
  .BackgroundManager-bgContainer[data-ambient] { animation: none !important; }
  .BackgroundManager-bgContainer[data-ambient]::before { animation: none !important; }
}

@keyframes fade-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
.BackgroundManager-FormSwitch {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 4px 16px;
  margin-bottom: 20px;
  & label {
    display: contents;
    cursor: pointer;
  }
  &:has([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }
}
.BackgroundManager-FormNumberInput {
  display: grid;
  grid-template-columns: 1fr 100px auto;
  align-items: center;
  gap: 4px;
  margin-bottom: 20px;
  &:has([disabled]) {
    opacity: 0.5;
  }
}
.BackgroundManager-FormSelect {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 16px;
  margin-bottom: 20px;
  &:has([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }
}
.BackgroundManager-Select {
  padding: 8px 12px;
  border-radius: 4px;
  background-color: var(--background-secondary, #2f3136);
  color: var(--text-normal, #dcddde);
  border: none;
  cursor: pointer;
  font-size: 14px;
  min-width: 150px;
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 18px) calc(1em + 2px), calc(100% - 13px) calc(1em + 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.BackgroundManager-Select:hover {
  background-color: var(--background-tertiary, #36393f);
}
.BackgroundManager-Select:focus {
  outline: 2px solid var(--focus-primary, #00aff4);
}
.BackgroundManager-Select option {
  background-color: var(--background-secondary, #2f3136) !important;
  color: var(--text-normal, #dcddde) !important;
}
.BackgroundManager-head { display: flex; align-items: center; gap: 8px; }
.BackgroundManager-head h1 { flex: 1; margin: 0; }
.BackgroundManager-head .BackgroundManager-SettingsButton { margin-left: auto; }
.BackgroundManager-quickRow .BackgroundManager-SettingsButton { margin-left: auto; }
.BackgroundManager-NumberInput {
  white-space: nowrap;
  padding-block: 0.25rem;
  text-align: right;
}
.BackgroundManager-inputWrapper {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  padding: 0.5rem 0.75rem 0.5rem 0.25rem;
  gap: 0.5rem;
  align-items: center;
}
.BackgroundManager-DropAndPasteArea {
  position: relative;
  display: grid;
  align-items: center;
  justify-items: center;
  gap: 8px;
  /* Schmale Leiste: auffindbar, ohne den Kategorien den Platz zu nehmen. */
  min-height: 62px;
  padding: 10px;
  border-radius: 10px;
  border: 1px dashed rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.02);
  transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
  outline: none;
  grid-row: span 3;
  caret-color: transparent;
  background-repeat: no-repeat;
  background-position: center 18px;
}
.BackgroundManager-DropAndPasteArea:is(:focus, .dragging, :focus-visible)::before {
  opacity: 1;
}
  .BackgroundManager-DropAndPasteArea::before {
  content: 'Drop image here or click to upload';
  position: absolute;
  display: grid;
  place-items: center;
  inset: 0;
  opacity: 0.95;
  padding: 12px;
  border-radius: inherit;
  cursor: copy;
  font-size: 0.85rem;
  line-height: 1.3;
  white-space: pre-wrap;
  text-align: center;
  color: rgba(255,255,255,0.62);
  pointer-events: none;
  background: transparent;
  transition: transform 180ms ease, opacity 160ms ease;
}
.BackgroundManager-DropAndPasteArea:hover::before { transform: translateY(-2px); }
.BackgroundManager-DropAndPasteArea .drag-icon { display: none; }
@media (max-width: 700px) {
  .BackgroundManager-DropAndPasteArea { min-height: 56px; padding: 8px; }
  .BackgroundManager-DropAndPasteArea::before { font-size: 0.8rem; }
}
.BackgroundManager-UploadButton {color: var(--green-430); }
.BackgroundManager-UploadButton:is(:hover, :focus-visible) { color: var(--green-500); }
.BackgroundManager-UploadButton:active { color: var(--green-530); }
.BackgroundManager-SettingsButton { color: rgba(255,255,255,0.92); }
.BackgroundManager-SettingsButton:is(:hover, :focus-visible) { color: rgba(255,255,255,0.98); }
.BackgroundManager-SettingsButton:active { color: rgba(255,255,255,1); }
.BackgroundManager-RemoveBgButton { color: var(--red-430); }
.BackgroundManager-RemoveBgButton:is(:hover, :focus-visible) { color: var(--red-500); }
.BackgroundManager-RemoveBgButton:active { color: var(--red-530); }

.BackgroundManager-UploadButton,
.BackgroundManager-SettingsButton,
.BackgroundManager-nextButton,
.BackgroundManager-RemoveBgButton {
  display: grid;
  place-items: center;
  padding: 0.25rem;
  background-color: #0000;
  aspect-ratio: 1;
  border-radius: 0.25rem;
  transition: color 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
.BackgroundManager-imageWrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border-radius: .25rem;
  background-color: #0000;
  flex: 0 0 calc(50% - 0.25rem);
  aspect-ratio: 16 / 9;
  outline: 2px solid transparent;
  padding: 0;
  overflow: hidden;
  transition: outline-color 400ms cubic-bezier(0.4, 0, 0.2, 1), transform 200ms ease;
  cursor: grab;
}
.BackgroundManager-imageWrapper:active {
  cursor: grabbing;
}
.BackgroundManager-imageWrapper.dragging {
  opacity: 0.5;
  transform: scale(0.95);
}
.BackgroundManager-imageWrapper.drag-over {
  outline-color: var(--green-430, #43b581);
  transform: scale(1.02);
}
/* Das aktive Bild. Weiss und niedrig deckend statt farbig, damit es ueber
   jedem Motiv funktioniert. */
.BackgroundManager-imageWrapper.selected {
  outline-color: rgba(255, 255, 255, 0.55);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25),
              0 0 14px 2px rgba(255, 255, 255, 0.16);
}

/* Feine Lichtkante beim Ueberfahren. Kein farbiger Schein, sondern Licht,
   das auf eine Kante faellt - das ist der Unterschied zwischen hochwertig
   und Neon. */
.BackgroundManager-imageWrapper:hover {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18),
              0 0 10px 0 rgba(255, 255, 255, 0.10);
}

/* Der Favoriten-Stern glueht warm, wenn er gesetzt ist. Nur auf dem Symbol,
   nicht auf der Flaeche. */
.BackgroundManager-favoriteButton.active svg {
  filter: drop-shadow(0 0 4px rgba(255, 193, 7, 0.75));
}
.BackgroundManager-image {
  object-fit: cover;
  min-height: 100%;
  min-width: 100%;
  animation: fade-in 250ms cubic-bezier(0.4, 0, 0.2, 1);
}
.BackgroundManager-imageWrapper:hover > .BackgroundManager-deleteButton,
.BackgroundManager-deleteButton:focus-visible {
  opacity: 1;
}
.BackgroundManager-imageData {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 0.25rem 0;
  font-size: .75rem;
  color: rgba(255, 255, 255, 0.6667);
  background: linear-gradient(#0000, rgba(25, 25, 25, 0.8) .175rem) no-repeat;
}
.BackgroundManager-imageData::before {
  content: 'SIZE: 'attr(data-size)'';
}
.BackgroundManager-imageData[data-dimensions]::after {
  content: attr(data-dimensions);
}
.BackgroundManager-imageWrapper:is(:hover, :focus-visible, :focus-within) .BackgroundManager-imageData[data-mime]::after,
.BackgroundManager-imageData[data-mime]:not([data-dimensions])::after {
  content: attr(data-mime);
  font-family: 'gg mono';
}
.BackgroundManager-favoriteButton {
  display: flex;
  position: absolute;
  inset: 3px auto auto 3px;
  border-radius: 4px;
  border: 0;
  padding: 1px;
  background-color: rgba(0, 0, 0, 0.5);
  opacity: 0;
  color: #fff;
  transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1), opacity 250ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms ease;
}
.BackgroundManager-favoriteButton.active {
  opacity: 1;
  color: #ffc107;
  background-color: rgba(0, 0, 0, 0.7);
}
.BackgroundManager-favoriteButton:is(:hover, :focus-visible) {
  background-color: rgba(0, 0, 0, 0.8);
  color: #ffc107;
}
.BackgroundManager-imageWrapper:hover > .BackgroundManager-favoriteButton {
  opacity: 1;
}
.BackgroundManager-deleteButton {
  display: flex;
  position: absolute;
  inset: 3px 3px auto auto;
  border-radius: 4px;
  border: 0;
  padding: 1px;
  background-color: #c62828;
  opacity: 0;
  color: #fff;
  transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1), opacity 250ms cubic-bezier(0.4, 0, 0.2, 1);
}
.BackgroundManager-deleteButton:is(:hover, :focus-visible) {
  background-color: #d15353; 
}
.BackgroundManager-quickButtons {
  display: flex;
  gap: 4px;
  padding: 8px;
  justify-content: flex-start;
}
.BackgroundManager-quickButton {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 4px;
  background: var(--background-modifier-hover);
  color: var(--interactive-normal);
  cursor: pointer;
  transition: color 150ms ease, background-color 150ms ease;
}
.BackgroundManager-quickButton:hover {
  background-color: var(--background-modifier-active);
  color: var(--interactive-hover);
}
.BackgroundManager-quickButton.active {
  color: #ffc107;
  background-color: var(--background-modifier-selected);
}
.BackgroundManager-categoryBar {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  align-items: center;
}
.BackgroundManager-categorySelect {
  flex: 1;
  padding: 6px 10px;
  border-radius: 4px;
  border: none;
  background: var(--background-modifier-accent);
  color: var(--text-normal);
  font-size: 14px;
  cursor: pointer;
  outline: none;
}
.BackgroundManager-categorySelect:hover {
  background: var(--background-modifier-hover);
}
.BackgroundManager-categorySelect:focus {
  box-shadow: 0 0 0 2px var(--focus-primary);
}
.BackgroundManager-categoryButton {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: var(--background-modifier-accent);
  color: var(--text-normal);
  font-size: 18px;
  cursor: pointer;
  transition: background-color 150ms ease;
}
.BackgroundManager-categoryButton:hover {
  background: var(--background-modifier-hover);
}
.BackgroundManager-categoryButton.delete {
  background: #c62828;
  color: #fff;
}
.BackgroundManager-categoryButton.delete:hover {
  background: #d15353;
}
.BackgroundManager-categoryInputRow {
  display: flex;
  gap: 8px;
  padding: 0 12px 8px;
}
.BackgroundManager-categoryInput {
  flex: 1;
  padding: 6px 10px;
  border-radius: 4px;
  border: none;
  background: var(--background-modifier-accent);
  color: var(--text-normal);
  font-size: 14px;
  outline: none;
}
.BackgroundManager-categoryInput:focus {
  box-shadow: 0 0 0 2px var(--focus-primary);
}
.BackgroundManager-gridWrapper {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  overflow: auto;
  padding: 0.5rem 0.25rem;
  margin-bottom: 0.5rem;
  align-content: start;
  scrollbar-gutter: stable;
  mask-image: linear-gradient(#0000, #000 0.5rem, #000 calc(100% - 0.5rem), #0000 100%), linear-gradient(to left, #000 0.75rem, #0000 0.75rem);
}

.BackgroundManager-popoutWrap {
  display: flex;
  align-items: flex-start;
  /* align to the right to match the Popout's align:'right' anchoring instead of centering,
     which was fighting the actual anchor position and causing the backdrop to render off to one side */
  justify-content: flex-end;
  padding: 12px 12px 8px 12px;
  /* Only the visible card (.BackgroundManager-popoutInner) should catch clicks. The wrap itself
     can end up overlapping the toolbar icon above it; making it click-through here means the icon
     stays clickable (to close the popout) even where the wrap's invisible bounding box covers it. */
  pointer-events: none;
  background: none;
  box-shadow: none;
}
/* Safety net: Discord's own messagesPopoutWrap-xxxx class (still applied alongside ours for
   positioning/behavior compatibility) may carry its own background/shadow/backdrop-filter that
   would otherwise show through unpredictably. Force it off so only our own card renders visually. */
.BackgroundManager-popoutWrap[class*="messagesPopoutWrap"] {
  background: none !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
}
.BackgroundManager-popoutInner {
  width: min(760px, 92vw);
  max-height: min(calc(100vh - 96px), 80vh);
  background: rgba(18,18,18,0.78);
  backdrop-filter: blur(10px) saturate(1.05);
  border-radius: 12px;
  padding: 10px 10px 18px 10px;
  box-shadow: 0 18px 52px rgba(0,0,0,0.68);
  overflow: visible; /* popout itself stays fixed; gallery will scroll */
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.BackgroundManager-popoutInner > .messagesPopoutWrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: auto;
}

.BackgroundManager-gridWrapper {
  flex: 1 1 auto;
  overflow: auto; /* gallery/groups area scrolls */
  max-height: min(calc(100vh - 216px), 60vh); /* leave space for header and controls, scaled with viewport instead of a fixed offset */
  padding: 12px !important;
  box-sizing: border-box;
  transform: translateZ(0); /* promote layer to reduce scroll jank */
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
  gap: 12px !important; /* enforce spacing between items */
}

/* Restore gaps and reserve image height to avoid layout shifts */
.BackgroundManager-gridWrapper > .BackgroundManager-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  align-items: start;
}

.BackgroundManager-gridWrapper > * {
  padding: 6px;
  box-sizing: border-box;
  min-height: 100px;
  margin-bottom: 12px;
}

.BackgroundManager-gridWrapper .BackgroundManager-group,
.BackgroundManager-gridWrapper .BackgroundManager-item {
  min-height: 110px;
}

.BackgroundManager-gridWrapper img {
  width: 100%;
  height: 110px;
  object-fit: cover;
  display: block;
}

/* Die Karte, die von vorn nach hinten wandert.
   Eine normale transition kann nur GERADLINIG zwischen zwei Punkten
   interpolieren - damit gibt es kein Anheben und kein Herumfuehren. Deshalb
   hier echte Keyframes mit Zwischenstationen. Die Start- und Zielkoordinaten
   kommen per CSS-Variable aus dem JSX, weil sie von der Stapelgroesse
   abhaengen.

     0%   vorn oben, volle Deckkraft
     28%  angehoben, noch vorne  -> "Karte aus dem Faecher nehmen"
     72%  hinten angekommen, leicht ueber der Zielhoehe
     100% unten eingereiht, blendet aus

   Ausgeblendet wird erst ab 78%, damit der Weg wirklich sichtbar ist. */
@keyframes BackgroundManager-cardToBack {
  0% {
    transform: translate3d(calc(-50% + var(--bm-x-from)), var(--bm-y-from), 0) rotate(0deg) scale(1);
    opacity: 1;
    z-index: 400;
  }
  36% {
    /* Angehoben und noch VORN. Der z-index bleibt bis hierher oben - genau
       das ist der Punkt: faellt er schon bei 0%, liegt die Karte sofort
       hinter allen anderen, das zweite Bild springt frei und es sieht aus,
       als wuerde die Karte aus der Mitte hochgezogen. */
    transform: translate3d(calc(-50% + var(--bm-x-from) + 12px), calc(var(--bm-y-from) - 62px), 0) rotate(4deg) scale(1.05);
    opacity: 1;
    z-index: 400;
  }
  38% {
    /* Erst jetzt hinter den Stapel. Der Wechsel ist hart, faellt aber nicht
       auf, weil die Karte hier bereits ueber den anderen schwebt. */
    z-index: 1;
  }
  72% {
    transform: translate3d(calc(-50% + var(--bm-x-to)), calc(var(--bm-y-to) - 26px), 0) rotate(var(--bm-rot-to, 0deg)) scale(0.97);
    opacity: 1;
  }
  82% { opacity: 1; }
  100% {
    transform: translate3d(calc(-50% + var(--bm-x-to)), var(--bm-y-to), 0) rotate(var(--bm-rot-to, 0deg)) scale(1);
    /* 0 wenn die Karte aus dem Fenster faellt, 1 wenn sie sichtbar unten
       wieder einreiht (Kategorien mit hoechstens 5 Bildern). */
    opacity: var(--bm-op-end, 0);
    z-index: 1;
  }
}

/* Stack GPU hints to reduce animation jank */
.BackgroundManager-categoryStack img {
  will-change: transform;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  -webkit-transform-style: preserve-3d;
}

/* :first-child ist wichtig - das Label ist ein zweites > div und darf die
   erzwungene Hoehe nicht bekommen. */
.BackgroundManager-categoryStack > div:first-child {
  height: 176px !important;
  padding-bottom: 0 !important;
  box-sizing: border-box;
  pointer-events: none; /* Klicks sollen die Kachel treffen, nicht das Einzelbild */
}

.BackgroundManager-categoryStack img {
  width: 190px !important;
  height: 120px !important;
  object-fit: cover;
}

.BackgroundManager-categoryStack {
  position: relative;
  overflow: visible;   /* die Faecherung darf seitlich ueberstehen */
  min-height: 0;
  cursor: pointer;
  border-radius: 10px;
}

.BackgroundManager-categoryStack img { pointer-events: auto; }

/* Name und Anzahl unter dem Stapel, dauerhaft sichtbar. */
.BackgroundManager-categoryLabel {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1.3;
}

.BackgroundManager-categoryName {
  color: var(--text-normal, rgba(255,255,255,0.9));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.BackgroundManager-categoryCount {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, rgba(255,255,255,0.45));
}

.BackgroundManager-categoryStack:hover .BackgroundManager-categoryName {
  color: var(--interactive-active, #fff);
}

/* Make stacks keyboard-focusable and show label on focus */
.BackgroundManager-categoryStack:focus {
  outline: 2px solid var(--focus-primary, rgba(0,170,255,0.9));
  outline-offset: 2px;
}

BackgroundManager-gridWrapper::-webkit-scrollbar,
.BackgroundManager-gridWrapper::-webkit-scrollbar-thumb,
.BackgroundManager-gridWrapper::-webkit-scrollbar-track {
}

 

.BackgroundManager-gridWrapper::-webkit-scrollbar {
  width: 10px;
}
.BackgroundManager-gridWrapper::-webkit-scrollbar-track {
  background: rgba(0,0,0,0.12);
  border-radius: 10px;
}
.BackgroundManager-gridWrapper::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.06);
  border-radius: 10px;
  border: 2px solid rgba(0,0,0,0.18);
}
.BackgroundManager-gridWrapper::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.12);
}
`);
  }

  /**
   * Adds a suffix to a number
   * @param {number} num The number to append a suffix to
   * @returns {string}
   */
  function formatNumber(num) {
    const units = [
      { value: 1099511627776, symbol: " TiB" },
      { value: 1073741824, symbol: " GiB" },
      { value: 1048576, symbol: " MiB" },
      { value: 1024, symbol: " KiB" },
      { value: 1, symbol: " B" },
    ];
    for (const unit of units) {
      if (num >= unit.value) {
        return (num / unit.value).toFixed(1).replace(/\.0$/, '') + unit.symbol;
      }
    }
    return num.toString();
  }

  /**
   * Accessing the database and either sets the selected image as a background, or calls the callback with all items.
   * @param {undefined | (storedItems: ImageItem[]) => void} callback Callback when the items have been loaded from the database
   */
  async function setImageFromIDB(callback) {
    let db;
    return openDB('images')
      .then(database => {
        db = database;
        return getAllItems(db, 'images');
      })
      .then(storedItems => {
        callback(storedItems);
        saveItems(db, 'images', storedItems, storedItems);
      })
      .catch(err => {
        console.error('Error opening database:', err);
      }).finally(() => {
        db?.close();
      });
  }

  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false };
    }

    static getDerivedStateFromError(error) {
      return { hasError: true };
    }

    componentDidCatch(error, info) {
      console.error(error, info);
    }

    render() {
      return this.state.hasError ? jsx('div', { style: { color: '#f03' } }, 'Component Error') : this.props.children;
    }
  }

  /**
   * Returns the first element that is a ancestor of node that matches selectors.
   * @param {HTMLElement} node The HTMLelement to start the search from.
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} query A string containing one or more CSS selectors to match against.
   * @returns {HTMLElementTagNameMap[K] | null} The first parent node that matches the specified group of selectors, or null if no matches are found.
   */
  function reverseQuerySelector(node, query) {
    while (node !== null && node !== document) {
      if (node.matches(query)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** Force rerenders a given element, or the first found element that matches the given selector.
   * @param {HTMLElement | string} element An HTMLElement or Selector
   */
  function forceRerenderElement(element) {
    // taken and refactored from Zerthox - https://github.com/Zerthox/BetterDiscord-Plugins/blob/8ae5b44c2fc29753336cc67f31b6b99ead5608d5/packages/dium/src/utils/react.ts#L189-L208
    const queryFiber = (fiber, callback) => {
      let count = 50, parent = fiber;

      do {
        if (callback(parent)) {
          return parent;
        }
        parent = parent.return;
      } while (parent && --count);

      return null;
    };

    const forceFullRerender = fiber => new Promise(resolve => {
      const owner = queryFiber(fiber, node => node?.stateNode instanceof React.Component);
      if (owner) {
        owner.stateNode.forceUpdate(() => resolve(true));
      } else {
        resolve(false);
      }
    });
    const node = element instanceof HTMLElement ? element : document.querySelector(element);
    node ? forceFullRerender(BdApi.ReactUtils.getInternalInstance(node)) : console.warn('%c[BackgroundManager] %cCould not rerender element', "color:#DBDCA6;font-weight:bold", "");
  }

  /** Returns the mime type of the image @param {Uint8Array} buffer The UInt8Array buffer */
  function getImageType(buffer) {
    const mimeTypes = [
      { mime: 'image/png', pattern: [0x89, 0x50, 0x4E, 0x47] },
      { mime: 'image/jpeg', pattern: [0xFF, 0xD8, 0xFF] },
      { mime: 'image/bmp', pattern: [0x42, 0x4D] },
      { mime: 'image/gif', pattern: [0x47, 0x49, 0x46, 0x38] },
      { mime: 'image/avif', pattern: [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] },
      { mime: 'image/webp', pattern: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
      { mime: 'image/svg+xml', pattern: [0x3C, 0x73, 0x76, 0x67] },
      { mime: 'image/x-icon', pattern: [0x00, 0x00, 0x01, 0x00] },
    ];
    for (const { mime, pattern } of mimeTypes)
      if (pattern.every((e, i) => e === null || e === buffer[i]))
        return mime;
    return '';
  }

  /**
   * Optimize a newly uploaded image by re-encoding it to WebP at the same resolution.
   * Skips animated GIFs, SVG and ICO. Returns the new Blob/File (keeps name if possible).
   * @param {Blob} blob
   * @param {string} [filename]
   * @returns {Promise<Blob|File>}
   */
  async function optimizeNewUpload(blob, filename) {
    try {
      if (!blob || !blob.type || !blob.type.startsWith('image/')) return blob;
      if (blob.type === 'image/gif' || blob.type === 'image/svg+xml' || blob.type === 'image/x-icon') return blob;

      const imageBitmap = await createImageBitmap(blob);
      const width = imageBitmap.width;
      const height = imageBitmap.height;

      const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0, width, height);

      // tuned quality: higher value -> less compression (target ~1-2 MiB for large images)
      const QUALITY = 0.995;
      if (canvas.convertToBlob) {
        const out = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
        try { if (filename && typeof File !== 'undefined') return new File([out], filename.replace(/\.[^.]+$/, '.webp'), { type: out.type }); } catch (e) {}
        return out;
      } else if (canvas.toBlob) {
        const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', QUALITY));
        try { if (filename && typeof File !== 'undefined') return new File([out], filename.replace(/\.[^.]+$/, '.webp'), { type: out.type }); } catch (e) {}
        return out || blob;
      }
      return blob;
    } catch (e) {
      console.warn('[BackgroundManager] optimizeNewUpload failed', e);
      return blob;
    }
  }

  // Inits and Event Listeners
  /** Manager to start and stop the slideshow. Internally handles the interval */
  const slideShowManager = function () {
    let interval, resumeTimer, lastTick = 0, pausedRemaining = null, triggeredWhileHidden = false;
    function handleVisibilityChange(e) {
      e.target.visibilityState === 'visible' && (triggeredWhileHidden = false);
    }
    function start() {
      stop();
      document.addEventListener("visibilitychange", handleVisibilityChange);
      lastTick = Date.now();
      interval = setInterval(tick, Math.max(constants.settings.slideshow.interval ?? 10000, 1000));
    }

    /* Anhalten und exakt weiterlaufen.
       setInterval kennt kein Pausieren - beim Neustart faengt die volle
       Wartezeit von vorn an. Deshalb wird beim Anhalten die bereits
       verstrichene Zeit gemerkt und beim Fortsetzen nur der REST abgewartet;
       erst danach laeuft wieder der normale Takt. So springt die Diashow nach
       einer Vorschau genau dort weiter, wo sie stand. */
    function pause() {
      if (!interval && !resumeTimer) return;
      const total = Math.max(constants.settings.slideshow.interval ?? 10000, 1000);
      pausedRemaining = Math.max(0, total - (Date.now() - lastTick));
      clearInterval(interval); interval = null;
      clearTimeout(resumeTimer); resumeTimer = null;
    }

    function resume() {
      if (pausedRemaining === null) return;
      if (!constants.settings.slideshow.enabled) { pausedRemaining = null; return; }
      const rest = pausedRemaining;
      pausedRemaining = null;
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        tick();
        lastTick = Date.now();
        interval = setInterval(tick, Math.max(constants.settings.slideshow.interval ?? 10000, 1000));
      }, rest);
    }

    async function tick() {
      lastTick = Date.now();
      {
        if (document.visibilityState === 'hidden') {
          if (triggeredWhileHidden) return;
          else triggeredWhileHidden = true;
        }
        try {
          const mounted = document.querySelector('.BackgroundManager-gridWrapper');
          // Use cached images if available to avoid DB hits
          const storedImages = Array.isArray(constants._cachedImages) ? constants._cachedImages : [];
          let availableImages = storedImages.slice();
          if (constants._slideshowFavoritesOnly) {
            const favs = availableImages.filter(img => img.favorite);
            availableImages = favs.length ? favs : storedImages.slice();
          }
          const scf = constants._slideshowCategoryFilters;
          if (Array.isArray(scf) && scf.length) {
            availableImages = availableImages.filter(img => scf.includes((img.category || FALLBACK_CATEGORY)));
          } else if (typeof scf === 'string' && scf) {
            availableImages = availableImages.filter(img => (img.category || FALLBACK_CATEGORY) === scf);
          }
          if (availableImages.length === 0) return;
          const currentIndex = availableImages.reduce((p, c, i) => c.selected ? i : p, null);
          if (constants.settings.slideshow.shuffle && availableImages.length > 2) {
            let x, counter = 0;
            do x = Math.floor(Math.random() * availableImages.length)
            while (x === currentIndex && counter++ < 25)
            // deselect all
            storedImages.forEach(e => {
              if (!mounted) {
                clearObjectURL(e);
                e.src = null;
              }
              e.selected = false;
            });
            const selectedImage = availableImages[x];
            selectedImage.selected = true;
            !mounted && setObjectURL(selectedImage, selectedImage.image);
            viewTransition.setImage(selectedImage.src);
            // persist changes
            try {
              const db = await openDB('images');
              await saveItems(db, 'images', storedImages, storedImages);
              db.close();
            } catch (err) { console.error(err) }
            console.log('%c[DynamicBackgrounds] %cBild gewechselt:', "color:#DBDCA6;font-weight:bold", "", new Date())
          } else if (availableImages.length) {
            const nextIndex = ((currentIndex ?? -1) + 1) % availableImages.length;
            storedImages.forEach(e => {
              if (!mounted) {
                clearObjectURL(e);
                e.src = null;
              }
              e.selected = false;
            });
            const selectedImage = availableImages[nextIndex];
            selectedImage.selected = true;
            !mounted && setObjectURL(selectedImage, selectedImage.image);
            viewTransition.setImage(selectedImage.src);
            try {
              const db = await openDB('images');
              await saveItems(db, 'images', storedImages, storedImages);
              db.close();
            } catch (err) { console.error(err) }
            console.log('%c[DynamicBackgrounds] %cBild gewechselt:', "color:#DBDCA6;font-weight:bold", "", new Date())
          }
        } catch (err) { console.error(err) }
      }
    }
    function stop() {
      interval && clearInterval(interval);
      interval = null;
      resumeTimer && clearTimeout(resumeTimer);
      resumeTimer = null;
      pausedRemaining = null;
      triggeredWhileHidden = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    return { start, stop, pause, resume }
  }();

  /**  Controller for switching images */
  const viewTransition = function () {
    let bgContainer, activeIndex = 0, domBG = [], property, originalBackground = true, cleanupPatch, currentSrc, timer;
    function applyProperties() {
      bgContainer.style.setProperty('--BgManager-transition-duration', (constants.settings.transition.enabled ? constants.settings.transition.duration ?? 0 : 0) + 'ms');
      bgContainer.setAttribute('data-transition', constants.settings.transition.type || 'fade');
      bgContainer.setAttribute('data-ambient', constants.settings.transition.ambient || 'none');
      applyAmbientSpeed(constants.settings.transition.ambientSpeed);
      constants.settings.adjustment.xPosition && bgContainer?.style.setProperty('--BgManager-position-x', constants.settings.adjustment.xPosition + '%');
      constants.settings.adjustment.yPosition && bgContainer?.style.setProperty('--BgManager-position-y', constants.settings.adjustment.yPosition + '%');
      constants.settings.adjustment.dimming && bgContainer?.style.setProperty('--BgManager-dimming', constants.settings.adjustment.dimming);
      constants.settings.adjustment.blur && bgContainer?.style.setProperty('--BgManager-blur', constants.settings.adjustment.blur + 'px');
      constants.settings.adjustment.grayscale && bgContainer?.style.setProperty('--BgManager-grayscale', constants.settings.adjustment.grayscale + '%');
      constants.settings.adjustment.saturate !== 100 && bgContainer?.style.setProperty('--BgManager-saturation', constants.settings.adjustment.saturate + '%');
      constants.settings.adjustment.contrast !== 100 && bgContainer?.style.setProperty('--BgManager-contrast', constants.settings.adjustment.contrast + '%');
    }
    // Use React component instead of DOM manipulation, as Discord sometimes removes those.
    function baseLayerBg() {
      const containerRef = useRef();
      const bg0Ref = useRef();
      const bg1Ref = useRef();
      useEffect(() => {
        bgContainer = containerRef.current;
        domBG = [bg0Ref.current, bg1Ref.current];
        applyProperties();
        return () => {
          bgContainer = null;
          domBG = [];
        }
      }, []);
      return jsx('div', {
        ref: containerRef,
        className: 'BackgroundManager-bgContainer',
        children: [
          jsx('div', { ref: bg0Ref, className: 'BackgroundManager-bg' + (activeIndex === 0 ? ' active' : ''), style: activeIndex === 0 && currentSrc ? { backgroundImage: 'linear-gradient(rgba(0,0,0,var(--BgManager-dimming,0)), rgba(0,0,0,var(--BgManager-dimming,0))), url(' + currentSrc + ')' } : null }),
          jsx('div', { ref: bg1Ref, className: 'BackgroundManager-bg' + (activeIndex === 1 ? ' active' : ''), style: activeIndex === 1 && currentSrc ? { backgroundImage: 'linear-gradient(rgba(0,0,0,var(--BgManager-dimming,0)), rgba(0,0,0,var(--BgManager-dimming,0))), url(' + currentSrc + ')' } : null })
        ]
      })
    }
    function create() {
      // Target: 718813 - renderArtisanalHack()
      const mod = Webpack.getBySource("\"disable-adaptive-theme\":");
      const ThemeProviderKey = mod && Object.keys(mod).filter((key) => (source =>
        ['"disable-adaptive-theme":'].every(str => source.includes(str))
      )(mod[key].toString()))[0];
      if (!ThemeProviderKey) {
        console.error('%c[BackgroundManager] %cCannot patch ThemeProvider: the internal string "disable-adaptive-theme:" was not found in Discord\'s bundle anymore. Discord likely changed this internal component; the Webpack.getBySource() filter in viewTransition.create() needs to be updated to match the current build.', "color:#DBDCA6;font-weight:bold", "");
        throw new Error("Cannot patch ThemeProvider");
      }
      cleanupPatch = Patcher.after(meta.slug, mod, ThemeProviderKey, (_, __, returnVal) => {
        if (returnVal.props?.children?.props?.className?.includes(constants.baseLayer.bg))
          returnVal.props.children.props.children = jsx(baseLayerBg)
      })
      forceRerenderElement('.' + constants.baseLayer.bg);
    }
    /* ---- Live-Vorschau ----
       Faehrt man im Raster ueber ein Bild, wird es kurz als echter Hintergrund
       gezeigt und beim Wegfahren wieder zurueckgesetzt. Bewusst OHNE die
       Auswahl zu aendern: es wird nichts gespeichert, nur angezeigt.
       previewBackup merkt sich das zuvor aktive Bild. */
    let previewBackup = null;

    /* Waehrend der Vorschau: Uebergangsdauer 0 und Diashow angehalten. Die
       Vorschau soll zeigen, wie ein Bild wirkt - nicht den Uebergang vorfuehren. */
    function previewImage(src) {
      if (!src || src === currentSrc) return;
      if (previewBackup === null) {
        previewBackup = currentSrc;
        bgContainer?.style.setProperty('--BgManager-transition-duration', '0ms');
        // pause() statt stop(): die Restlaufzeit bleibt erhalten
        try { slideShowManager.pause(); } catch (err) {}
      }
      setImage(src);
    }

    /** Uebergangsdauer und Diashow-Takt wieder so herstellen wie vor der Vorschau. */
    function restoreAfterPreview() {
      bgContainer?.style.setProperty('--BgManager-transition-duration',
        (constants.settings.transition.enabled ? constants.settings.transition.duration ?? 0 : 0) + 'ms');
      try { slideShowManager.resume(); } catch (err) {}
    }

    /** Maus verlaesst das Bild: vorheriges Bild zurueckholen. */
    function endPreview() {
      if (previewBackup === null) return;
      const restore = previewBackup;
      previewBackup = null;
      if (restore) setImage(restore);
      restoreAfterPreview();
    }

    /* Klick waehrend der Vorschau: Bild bleibt, Vorschau-Zustand endet.
       Ohne das bliebe die Diashow dauerhaft angehalten. */
    function commitPreview() {
      if (previewBackup === null) return;
      previewBackup = null;
      restoreAfterPreview();
    }

    /** @param {string} src  */
    function setImage(src) {

      currentSrc = src;
      if (domBG.length === 2) {
        document.visibilityState === 'visible' && (activeIndex ^= 1);
        domBG[activeIndex].style.backgroundImage = 'linear-gradient(rgba(0,0,0,var(--BgManager-dimming,0)), rgba(0,0,0,var(--BgManager-dimming,0))), url(' + src + ')';
        domBG[activeIndex].classList.add('active');
        domBG[activeIndex ^ 1].classList.remove('active');
      }
      if (!property || !constants.settings.overwriteCSS) return;
      if (originalBackground) {
        originalBackground = false;
        timer = setTimeout(() => {
          DOM.removeStyle('BackgroundManager-background');
          DOM.addStyle('BackgroundManager-background', property.map(e => `${e.selector} {${e.property}: url('${src}') !important;}`).join('\n'));
          timer = null;
        }, constants.settings.transition.duration)
      } else {
        DOM.removeStyle('BackgroundManager-background');
        DOM.addStyle('BackgroundManager-background', property.map(e => `${e.selector} {${e.property}: url('${src}') !important;}`).join('\n'));
      }
    }
    function removeImage() {
      domBG.forEach(e => e.classList.remove('active'));
      originalBackground = true
      DOM.removeStyle('BackgroundManager-background');
    }
    function destroy() {
      cleanupPatch?.();
      constants.baseLayer?.bg && forceRerenderElement('.' + constants.baseLayer.bg);
      timer && (clearTimeout(timer), timer = null);
      originalBackground = true;
      DOM.removeStyle('BackgroundManager-background');
      bgContainer = null;
      currentSrc = null;
      previewBackup = null;   // sonst haengt eine laufende Vorschau nach
      activeIndex = 0;
      domBG = [];
    }
    function setProperty(overwrite = true) {
      const themes = document.querySelectorAll('bd-head  bd-themes style');
      if (!themes?.length) return;
      const foundProperties = [];
      for (const theme of themes) {
        const sheet = [...document.styleSheets].find(sheet => sheet.ownerNode === theme);
        if (!sheet) continue;
        const cssVariables = {};

        // Iterate through the CSS rules in the stylesheet
        for (const rule of sheet.cssRules) {
          if (!rule || rule instanceof CSSImportRule || !(rule instanceof CSSStyleRule)) continue;
          for (const customProperty of rule.style) {
            if (customProperty.startsWith('--')) {
              const value = rule.style.getPropertyValue(customProperty).trim();
              if (value.startsWith('url')) {
                if (!cssVariables[customProperty])
                  cssVariables[customProperty] = { value, selectors: [] };
                cssVariables[customProperty].selectors.push(rule.selectorText || ':root');
              }
            }
          }
        }
        // auf tatsaechlichen Inhalt pruefen, nicht auf das Objekt selbst
        if (!Object.keys(cssVariables).length) continue;
        let customProperty;
        block: if (Object.keys(cssVariables).length === 1) {
          customProperty = Object.keys(cssVariables)[0];
        } else {
          for (const key of Object.keys(cssVariables)) { // prioritize background, bg, backdrop
            if (['background', 'bg', 'wallpaper', 'backdrop'].some(e => key.toLowerCase().includes(e))) {
              customProperty = key;
              break block;
            }
          }
          for (const key of Object.keys(cssVariables)) { // if no variable is found, look for images.
            if (['image', 'img'].some(e => key.toLowerCase().includes(e))) {
              customProperty = key;
              break block;
            }
          }
        }
        if (!customProperty) continue;
        foundProperties.push({ property: customProperty, selector: cssVariables[customProperty].selectors[0] });
      }
      if (!foundProperties.length) return (property = null);
      property = foundProperties;
      overwrite && setImageFromIDB(storedImages => {
        storedImages.forEach(image => {
          if (image.selected && image.src) {
            DOM.removeStyle('BackgroundManager-background');
            DOM.addStyle('BackgroundManager-background', property.map(e => `${e.selector} {${e.property}: url('${image.src}') !important;}`).join('\n'));
          }
        })
      });
    }
    return { create, setImage, removeImage, destroy, bgContainer: () => bgContainer, setProperty, previewImage, endPreview, commitPreview }
  }();

  const themeObserver = function () {
    let nodeObserver, debounceTimer;
    function start() {
      if (nodeObserver) stop();

      // <bd-themes> fehlt, wenn das Theme in Custom CSS oder Vencord QuickCSS liegt.
      // observe(null) wuerde werfen und das Plugin ueber das catch deaktivieren.
      const target = document.querySelector('bd-head bd-themes');
      if (!target) {
        console.warn('%c[BackgroundManager] %cKein <bd-themes> gefunden - overwriteCSS wird uebersprungen. Das Plugin laeuft normal weiter und nutzt seine eigene Hintergrund-Ebene.', "color:#DBDCA6;font-weight:bold", "");
        return;
      }

      // setProperty() iteriert durch alle CSS-Regeln aller Themes - deshalb entprellt.
      nodeObserver = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => viewTransition.setProperty(), 200);
      })
      nodeObserver.observe(target, { childList: true, subtree: true });
    }
    function stop() {
      DOM.removeStyle('BackgroundManager-background');
      clearTimeout(debounceTimer);
      debounceTimer = null;
      nodeObserver?.disconnect();
      nodeObserver = null;
    }
    return { start, stop }
  }();

  /* --------------------------------------------------------------------------
     UPDATE-PRUEFUNG

     BetterDiscord wertet @updateUrl im Kopf dieser Datei NICHT aus - ohne
     Code hier ist der Eintrag reine Deko. Also selbst machen: beim Start die
     Fassung auf GitHub holen, @version vergleichen, und bei einer neueren
     Fassung anbieten, die Datei zu ersetzen. BetterDiscord bemerkt die
     geaenderte Datei von allein und laedt neu.

     Ueber normales fetch() laeuft das nicht: Discords CSP blockt fremde
     Hosts. BdApi.Net.fetch geht ueber den Hauptprozess daran vorbei.
     ----------------------------------------------------------------------- */

  const UPDATE_VERZOEGERUNG = 8000;   // Discord erst in Ruhe starten lassen
  let updateTimer = null;

  // Nur den Kopf durchsuchen - im Rumpf koennte '@version' als Text stehen.
  function versionAus(text) {
    return /@version\s+([0-9][0-9A-Za-z.\-+]*)/.exec(String(text).slice(0, 2000))?.[1] ?? null;
  }

  // Stellenweiser Zahlenvergleich: '3.10.0' ist neuer als '3.9.0'. Ein reiner
  // Textvergleich wuerde hier das Gegenteil behaupten.
  function istNeuer(fern, lokal) {
    const teile = v => String(v ?? '').split('.').map(n => parseInt(n, 10) || 0);
    const a = teile(fern);
    const b = teile(lokal);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  async function pruefeAufUpdates({ leise = true } = {}) {
    if (!meta.updateUrl || !meta.filename) return 0;

    let inhalt;
    try {
      // Cache-Buster: raw.githubusercontent liefert sonst minutenlang die
      // alte Fassung aus, und der Update-Check meldet nichts.
      const trenner = meta.updateUrl.includes('?') ? '&' : '?';
      const antwort = await BdApi.Net.fetch(meta.updateUrl + trenner + 't=' + Date.now(),
        { headers: { 'Cache-Control': 'no-cache' } });
      if (!antwort.ok) throw new Error('HTTP ' + antwort.status);

      inhalt = await antwort.text();

      // Wichtig: Eine falsche URL liefert eine HTML-Fehlerseite mit Status 200
      // statt einer Addon-Datei. Ohne diese Pruefung wuerde die einfach ueber
      // das laufende Plugin geschrieben und es waere kaputt.
      if (inhalt.length < 200 || !versionAus(inhalt)) {
        throw new Error('Antwort sieht nicht nach einer Addon-Datei aus');
      }
    } catch (e) {
      // Kein Netz, GitHub gerade weg, Tippfehler in der URL - kein Grund, den
      // Nutzer zu behelligen. Nur ins Log.
      console.warn('%c[BackgroundManager] %cUpdate check failed:', "color:#DBDCA6;font-weight:bold", "", e.message);
      return 0;
    }

    const fern = versionAus(inhalt);
    if (!istNeuer(fern, meta.version)) {
      if (!leise) UI.showToast('Everything is up to date.', { type: 'success' });
      return 0;
    }

    UI.showNotice(meta.name + ' ' + fern + ' is available (installed: ' + meta.version + ').', {
      type: 'info',
      buttons: [{
        label: 'Update',
        // BetterDiscord reicht dem Knopf die Funktion zum Schliessen der
        // Meldung als erstes Argument herein. Zuerst schliessen, dann melden:
        // das Schreiben stoesst BetterDiscords Neuladen an, und danach muss
        // hier nichts mehr passieren. Schlaegt es fehl, bleibt die Meldung
        // absichtlich stehen - sonst waere der zweite Versuch weg.
        onClick: async (schliessen) => {
          try {
            // Bewusst die Callback-Fassung und nicht fs.promises: das fs-Modul,
            // das Discords Renderer ueber require herausgibt, hat keine
            // promises-Eigenschaft. fs.promises.writeFile scheitert dort mit
            // "Cannot read properties of undefined".
            const fs = require('fs');
            const path = require('path');
            const ziel = path.join(BdApi.Plugins.folder, meta.filename);
            await new Promise((erfuellen, ablehnen) => {
              fs.writeFile(ziel, inhalt, 'utf8', fehler => fehler ? ablehnen(fehler) : erfuellen());
            });
            schliessen?.();
            UI.showToast(meta.name + ' updated to ' + fern + '.', { type: 'success' });
          } catch (e) {
            console.error('[BackgroundManager] Update failed:', e);
            UI.showToast('Update failed - see console.', { type: 'error' });
          }
        }
      }]
    });
    return 1;
  }

  return {
    start: async () => {
      // Bewusst als Erstes: scheitert der Rest, ist die Update-Pruefung erst
      // recht interessant - womoeglich behebt die neue Fassung genau das.
      updateTimer = setTimeout(() => { pruefeAufUpdates(); }, UPDATE_VERZOEGERUNG);

      try {
        !Object.keys(constants).length && console.log('%c[BackgroundManager] %cInitialized', "color:#DBDCA6;font-weight:bold", "")
        const configs = Data.load(meta.slug, "settings");
        // Gespeicherte Uebergaenge umbiegen, siehe legacyTransitionMap
        if (configs?.transition) configs.transition = migrateTransition(configs.transition);
        // Auffang-Kategorie in der Liste umbenennen, Duplikate vermeiden
        if (Array.isArray(configs?.categories) && configs.categories.includes(LEGACY_FALLBACK_CATEGORY)) {
          configs.categories = [...new Set(configs.categories.map(c => c === LEGACY_FALLBACK_CATEGORY ? FALLBACK_CATEGORY : c))];
        }
        if (configs?.selectedCategory === LEGACY_FALLBACK_CATEGORY) configs.selectedCategory = FALLBACK_CATEGORY;
        if (Array.isArray(configs?.slideshow?.categoryFilters)) {
          configs.slideshow.categoryFilters = configs.slideshow.categoryFilters.map(c => c === LEGACY_FALLBACK_CATEGORY ? FALLBACK_CATEGORY : c);
        }
        if (configs?.slideshow?.categoryFilter === LEGACY_FALLBACK_CATEGORY) configs.slideshow.categoryFilter = FALLBACK_CATEGORY;
        // Migrate legacy single slideshow.categoryFilter -> slideshow.categoryFilters (array)
        if (configs?.slideshow && configs.slideshow.categoryFilter && !configs.slideshow.categoryFilters) {
          try { configs.slideshow.categoryFilters = [configs.slideshow.categoryFilter]; } catch (e) {}
        }
        // Helper: run a module lookup safely and log a clear, labeled warning if it fails,
        // instead of letting one broken Webpack filter throw and silently kill the whole start().
        function safeLookup(label, fn) {
          try {
            const result = fn();
            if (result === undefined || result === null) {
              console.warn(`%c[BackgroundManager] %cModule lookup "${label}" returned nothing. Discord's internals may have changed (filter no longer matches).`, "color:#DBDCA6;font-weight:bold", "");
            }
            return result;
          } catch (e) {
            console.warn(`%c[BackgroundManager] %cModule lookup "${label}" threw an error:`, "color:#DBDCA6;font-weight:bold", "", e);
            return undefined;
          }
        }

        const modules = {
          toolbarClasses: safeLookup('toolbarClasses', () => Webpack.getByKeys("iconWrapper", "toolbar")), // classes for toolbar
          messagesPopoutClasses: safeLookup('messagesPopoutClasses', () => Webpack.getByKeys("messagesPopout")), // classes for messages popout
          textStyles: safeLookup('textStyles', () => Webpack.getByKeys("defaultColor")), // classes for general text styles
          markupStyles: safeLookup('markupStyles', () => Webpack.getByKeys("markup")),
          slider: safeLookup('slider', () => Webpack.getByKeys("sliderContainer", "slider")),
          layerContainerClass: safeLookup('layerContainerClass', () => Webpack.getByKeys("trapClicks")), // classes of Discord"s nativelayer container
          originalLink: safeLookup('originalLink', () => Webpack.getByKeys("originalLink")), // classes for image embed
          scrollbar: safeLookup('scrollbar', () => Webpack.getByKeys("thin")), // classes for scrollable content
          separator: safeLookup('separator', () => Webpack.getByKeys("scroller", "label")), // classes for separator
          baseLayer: safeLookup('baseLayer', () => Webpack.getByKeys("baseLayer", "bg")), // classes of Discord's base layer
          // Module for lazy carousel - non-essential, guarded so a miss here can't throw before the essential check runs
          lazyCarousel: safeLookup('lazyCarousel', () => {
            const mod = Webpack.getBySource(".MEDIA_VIEWER", ".OPEN_MODAL");
            return mod ? Object.values(mod)[0] : undefined;
          }),
          settings: {
            ...defaultSettings, ...configs,
            transition: { ...defaultSettings.transition, ...configs?.transition },
            slideshow: { ...defaultSettings.slideshow, ...configs?.slideshow },
            adjustment: { ...defaultSettings.adjustment, ...configs?.adjustment }
          },
          // native ui module - previously fetched via getMangled(m => m.showToast, {...}), but that
          // base-module lookup (m.showToast) no longer matches anything in current Discord builds.
          // Each component below is still findable individually, so look each one up directly instead.
          nativeUI: {
            FocusRing: safeLookup('nativeUI.FocusRing', () => Webpack.getModule(Filters.byStrings("FocusRing was given a focusTarget"), { searchExports: true })),
            FormTitle: safeLookup('nativeUI.FormTitle', () => Webpack.getModule(Filters.byStrings(".errorSeparator"), { searchExports: true })),
            MenuSliderControl: safeLookup('nativeUI.MenuSliderControl', () => Webpack.getModule(Filters.byStrings("moveGrabber"), { searchExports: true })),
            Popout: safeLookup('nativeUI.Popout', () => Webpack.getModule(Filters.byStrings("Unsupported animation config:"), { searchExports: true })),
            Spinner: safeLookup('nativeUI.Spinner', () => Webpack.getModule(Filters.byStrings(".stopAnimation]:"), { searchExports: true })),
            Tooltip: safeLookup('nativeUI.Tooltip', () => Webpack.getModule(Filters.byStrings("this.renderTooltip()]"), { searchExports: true })),
            useFocusLock: safeLookup('nativeUI.useFocusLock', () => Webpack.getModule(Filters.byStrings("disableReturnRef:"), { searchExports: true })),
          },
        }
        Object.assign(modules.nativeUI, {
          Button: safeLookup('nativeUI.Button', () => Webpack.getModule(Filters.byStrings(",submittingFinishedLabel:"), { searchExports: true })),
          TextInput: safeLookup('nativeUI.TextInput', () => Webpack.getModule(Filters.byStrings("allowOverflow", "autoFocus"), { searchExports: true })),
        })
        const requiredNativeUI = ["Popout", "Tooltip", "Spinner", "FocusRing"];
        const missingNativeUI = requiredNativeUI.filter(key => !modules.nativeUI[key]);
        if (!modules.baseLayer || missingNativeUI.length) {
          const missingList = [
            !modules.baseLayer ? 'baseLayer' : null,
            ...missingNativeUI.map(k => `nativeUI.${k}`)
          ].filter(Boolean).join(', ');
          console.error(`%c[BackgroundManager] %cCannot start: missing module(s) -> ${missingList}. Discord likely changed the internal code these filters look for; the filters in the plugin need to be updated.`, "color:#DBDCA6;font-weight:bold", "");
          throw new Error("Missing essential modules: " + missingList);
        }
        Object.assign(constants, modules);
        generateCSS();
        // On startup, refresh objectURL of stored selected image and populate in-memory cache.
        {
          let db;
          await openDB('images').then(database => {
            db = database;
            return getAllItems(db, 'images');
          }).then(storedItems => {
            storedItems.forEach(e => {
              clearObjectURL(e);
              e.src = e.selected ? ensureObjectURL(e) : null;
            });

            /* Einmalige Umbenennung der Auffang-Kategorie. Der Name steht an
               jedem Bild, deshalb muessen die Datensaetze mitgezogen werden -
               sonst blieben sie in einer Gruppe zurueck, die es nicht mehr gibt. */
            const toMigrate = storedItems.filter(e => e.category === LEGACY_FALLBACK_CATEGORY);
            if (toMigrate.length) {
              toMigrate.forEach(e => { e.category = FALLBACK_CATEGORY; });
              console.log('%c[BackgroundManager] %c' + toMigrate.length + ' Bild(er) von "' + LEGACY_FALLBACK_CATEGORY + '" nach "' + FALLBACK_CATEGORY + '" umgezogen.', "color:#DBDCA6;font-weight:bold", "");
              try { saveItems(db, 'images', storedItems, storedItems); } catch (e) { console.error(e); }
            }

            try { constants._cachedImages = storedItems.map(e => ({ ...e })); } catch (e) { /* ignore */ }
          }).catch(err => console.error(err)).finally(() => db?.close());
        }
        // create image containers
        viewTransition.create();
        // set up css property using refreshed objectURL
        constants.settings.overwriteCSS && viewTransition.setProperty();
        // finally, set the selected image, if any, as background. A bit convoluted, but order is important.
        await setImageFromIDB(storedImages => {
          const img = storedImages.find(image => image.selected);
          img && viewTransition.setImage(img.src)
        });
        // Start Slideshow if enabled
        constants.settings.slideshow.enabled && slideShowManager.start();
        constants.settings.overwriteCSS && themeObserver.start();
        addButton();
      } catch (e) {
        console.error(e);
        UI.showToast("Could not start BackgroundManager", { type: 'error' });
        BdApi.Plugins.disable(meta.id);
      }
    },
    stop: stop,
    getSettingsPanel: () => jsx(ErrorBoundary, null, jsx(BuildSettings))
  }
}


// Kategorie-Quick-Button-Komponente
function CategoryQuickButton({ categories, value, onChange }) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef();
  // value may be array (new) or string (legacy)
  const selected = Array.isArray(value) ? value : (value ? [value] : []);
  // Schließe Dropdown bei Klick außerhalb
  React.useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (!btnRef.current?.parentElement.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);
  return jsx('div', { style: { position: 'relative' } }, [
    jsx('button', {
      ref: btnRef,
      /* Chip wie die anderen; die Beschriftung zeigt die Zahl der gefilterten
         Kategorien direkt an. */
      className: 'BackgroundManager-chip' + (selected.length ? ' active amber' : ''),
      title: selected.length ? `Slideshow categories: ${selected.join(', ')}` : 'Select slideshow categories',
      onClick: () => setOpen(o => !o),
      children: [jsx('svg', { key: 'i', width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        children: jsx('path', { d: 'M10 4H2v16h20V6H12l-2-2z' })
      }),
      jsx('span', { key: 't' }, selected.length === 1 ? selected[0] : (selected.length ? selected.length + ' categories' : 'All categories'))]
    }),
    open && jsx('div', {
      style: {
        position: 'absolute', top: 36, left: 0, minWidth: 160, background: '#23272a', color: '#fff', borderRadius: 6, boxShadow: '0 4px 16px #000a', zIndex: 1000, padding: 4, fontSize: 15
      },
      children: [
        jsx('div', {
          style: { padding: '6px 12px', cursor: 'pointer', borderRadius: 4, background: (!selected || selected.length === 0) ? '#5865f2' : 'none', color: (!selected || selected.length === 0) ? '#fff' : undefined, marginBottom: 2 },
          onClick: () => { onChange([]); setOpen(false); },
          children: 'All categories'
        }),
        ...categories.map(cat => jsx('div', {
          key: cat,
          style: { padding: '6px 12px', cursor: 'pointer', borderRadius: 4, background: selected.includes(cat) ? '#5865f2' : 'none', color: selected.includes(cat) ? '#fff' : undefined, marginBottom: 2 },
          onClick: () => {
            const next = selected.includes(cat) ? selected.filter(c => c !== cat) : [...selected, cat];
            onChange(next);
            setOpen(false);
          },
          children: cat
        }))
      ]
    })
  ]);
}