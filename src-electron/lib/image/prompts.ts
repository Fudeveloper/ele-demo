/**
 * 图片生成提示词模板 —— 逐字移植自 `services.py`。
 */

export const SCENE_CONSTRAINTS = `The scene should fit this specific product naturally — anywhere it could plausibly appear or be used, indoor, semi-outdoor, or outdoor, is acceptable. Requirements: a solid hard flooring or grounding surface; clear catalog lighting with realistic shadows; the product fully visible and unobstructed; at most one tasteful prop. If a window covering appears, call it curtains.`;

export const SCENE_STYLE_HINTS: Record<number, string> = {
  0: "Scandinavian apartment — pale ash or white-oak wood floor, whitewashed walls, soft diffused northern daylight, calm neutral palette, minimalist cozy hygge mood",
  1: "Mediterranean villa — warm terracotta tile floor, limewashed plaster walls, golden afternoon sunlight, earthy ochre and olive tones, arched openings",
  2: "Japanese zen house — tatami or hinoki pale-wood floor, shoji screens, soft even diffused daylight, muted sage and sand tones, wabi-seri calm",
  3: "Industrial urban loft — raw polished concrete floor, exposed brick walls, large steel-frame windows, cool overcast light, charcoal and rust tones",
  4: "Mid-century modern home — terrazzo or warm walnut floor, teak accents, bright warm afternoon light, mustard and olive retro palette, tapered legs era",
  5: "Modern minimalist penthouse — seamless microcement floor, full-height glazing, crisp even daylight, monochrome grey and white palette, ultra-clean lines",
  6: "Coastal beach house — bleached oak or whitewashed plank floor, weathered shiplap walls, bright airy glare-free coastal light, sea-glass blue and sand tones",
  7: "Rustic farmhouse — wide reclaimed pine plank floor, exposed beams, warm amber lamp light, creamy whitewash and barnwood tones, country cozy mood",
  8: "Parisian classic apartment — herringbone parquet floor, tall moulded ceilings, ornate wall paneling, soft north light, elegant cream and gold tones",
  9: "Tropical pavilion / lanai — natural stone floor, open louvered walls, dappled sunlight through palms, lush green and teak tones, balmy resort mood",
  10: "Art-deco apartment — glossy black-and-gold geometric tile floor, lacquered walls, warm golden chandelier glow, emerald and brass jewel tones",
  11: "Mountain chalet — wide-plank spruce floor, timber-clad walls, warm glowing fireplace light, forest green and warm wood tones, alpine lodge mood",
};

export function sceneStyleHint(imageIndex: number): string {
  const keys = Object.keys(SCENE_STYLE_HINTS).map(Number).sort((a, b) => a - b);
  if (!keys.length) return "";
  const key = keys[imageIndex % keys.length];
  return key !== undefined ? (SCENE_STYLE_HINTS[key] ?? "") : "";
}

export const PLAIN_PRODUCT_BACKGROUND_PROMPT = `Use the attached image as an ecommerce product reference, not as a scene
reference.

Plain product/lifestyle photo mode:
- Keep only the real product, existing animals, accessories, product structure,
  color, material, scale, and perspective faithful to the source.
- Treat this as a product cutout placed into a new scene, not as background
  retouching. Remove all source background pixels and visual memory.
- Completely replace the original background with the exact scene described in the
  SCENE block below. The new scene must have hard flooring/grounding, clear catalog
  lighting, realistic shadows, and a layout that suits the product subject. Do not
  invent a different scene than the one specified.
- If the source looks like a backyard, garden, lawn, fence, flower bed, or patio
  snapshot, the final image must not be another backyard/garden/lawn/fence
  scene. No lawn, no wooden fence, no flower bed, no garden tools, no watering
  can, no stepping-stone path, no copied house exterior, no copied tree line.
- If the source is indoor or studio-like, use a different room type, different
  wall/floor material, different lighting, and different camera context.
- Use attractive catalog lighting, realistic shadows, tasteful minimal props,
  and a polished purchase-oriented composition.
- Keep the product fully visible and unobstructed. Do not distort geometry, add
  extra products, duplicate product parts, or change functional details.
- The output must contain zero new text. Do not add any text, numbers, labels, badges, charts, diagrams, callout
  panels, logos, watermarks, QR codes, or promotional copy.
- Selling points and feature claims count as text. Only selling-point or
  feature text already visible in the source image may appear in the output.
  Do not create new slogans, benefit claims, labels, or feature descriptions.
- Photorealistic polished ecommerce catalog quality.`;

export const DEFAULT_BACKGROUND_PROMPT = `Use the attached image as the source for an ecommerce image edit, not as loose
inspiration for a new image. The goal is to make the product image more
attractive and noticeably different from the source for marketplace
deduplication, while keeping the product information reliable.

Absolute text rule:
- The output must contain zero new text, numbers, badges, charts, diagrams,
  labels, icons, callout panels, or information boxes that are not already
  visible in the source image.
- Selling points and feature claims count as protected text. Only
  selling-point or feature text already visible in the source image may appear;
  do not create new slogans, benefit claims, labels, or feature descriptions.
- If the source has no text or infographic elements, the output must also have
  no text or infographic elements.
- If the source has text or infographic elements, copy only the original
  elements. Do not invent replacement panels or redesigned callouts.

Before editing, classify the source:
1. Plain product/lifestyle photo: little or no text, mostly product and
   background.
2. Infographic/detail/measurement image: contains any text, measurements,
   arrows, icons, diagrams, callouts, badges, comparison panels, or white
   information areas.

Editing mode:
- For plain product/lifestyle photos, make a substantial category-appropriate
  lifestyle background change. Do not keep the original yard, room, wall,
  floor, sky, fence, or studio setup. Create a clearly different environment
  with different flooring/ground, plants, props, lighting, depth, and background
  layout while keeping the product itself faithful. Treat only the product and
  existing animals/accessories as protected; the original background should be
  fully removed and replaced so it is not recognizable. Do not recreate the
  same scene composition; use a different location, ground material,
  architecture, plant layout, lighting, and camera context. If the source is a
  backyard/garden/lawn/fence scene, choose a non-backyard premium setting such
  as a clean stone courtyard, covered terrace, rooftop patio, sunroom, or
  showroom-like home setting, without the source lawn, fence, flower bed,
  watering can, or stepping-stone path.
- For infographic/detail/measurement images, do not turn the whole image into a
  lifestyle scene. Keep the original canvas composition, white/information
  areas, product placement, text blocks, diagrams, arrows, icons, labels, and
  spacing. Only improve or replace non-text background/photo areas while keeping
  all information readable.
- For infographic/detail/measurement images, the final image must still feel
  like one coherent ecommerce canvas from top to bottom. Do not create a split
  composition where the top/side information area looks like an unchanged
  poster or screenshot pasted onto a separate lifestyle scene.
- Title strips, callout cards, dimension labels, and icons may sit as clean
  overlays, but the visible background behind and between them should share the
  same scene, lighting, perspective, color temperature, and depth as the rest
  of the image.
- For infographic/detail/measurement images, preservation is more important
  than deduplication. If a background change would make any original text,
  number, arrow, icon, diagram, or selling-point copy less faithful or less
  readable, leave that protected area unchanged from the source.

Hard preservation rules:
- Treat every existing text, number, arrow, icon, line, badge, diagram,
  dimension marker, and information panel as a locked layer copied from the
  source image. These protected regions must remain pixel-faithful and readable.
- Preserve the real product, accessories, quantity, scale, perspective, structure,
  color, material texture, doors, drawers, trays, handles, hardware, openings,
  panels, and visible functional parts. Do not redesign the product.
- Preserve every existing text or information element exactly as it appears:
  measurement numbers, dimension labels, feature/selling-point copy, icons,
  arrows, callout lines, diagrams, comparison panels, badges, and infographic
  layouts. Do not remove, rewrite, translate, invent, crop, blur, or cover any
  existing text or size/selling-point information.
- If the source image is an infographic or has white space for text, keep the
  same readable layout and text placement. Only improve the product area and the
  background/scene around it.
- Do not crop, zoom, reposition, or cover protected information areas. If a
  scene background would conflict with text readability, keep that area clean
  and close to the source.

Creative direction:
- Replace plain, dull, or studio-like backgrounds with a category-appropriate,
  aspirational lifestyle scene that helps customers imagine using the product:
  home interior, covered terrace, clean stone courtyard, rooftop patio, sunroom,
  showroom-like home setting, office, garage, workshop, nursery, kitchen, or
  other relevant setting.
- Make the background change substantial and obvious. Add natural depth,
  attractive lighting, realistic shadows, tasteful props, plants, flooring,
  walls, outdoor landscaping, or environmental context when appropriate.
- Keep the product fully visible and unobstructed. Props and background elements
  must support the product and must not overlap important product details, text,
  arrows, labels, dimensions, or selling points.
- For text-heavy images, the visible difference should come from improved
  product/background/photo regions, lighting, shadows, and scene fragments, not
  from deleting the original infographic content.
- Do not add people. Do not add new brand names, watermarks, logos, QR codes, or
  new promotional text. Existing text from the source must remain.

Quality requirements:
- Photorealistic, polished ecommerce catalog quality; natural colors, clean
  composition, realistic contact shadows, and consistent perspective.
- Avoid a plain white-box showroom result unless the source is a technical
  infographic whose text area must stay clean and readable.
- Avoid distorted geometry, unreadable text, duplicated parts, extra products,
  messy artifacts, overexposure, or heavy blur.`;

export const INFORMATION_IMAGE_PROMPT = `This source appears to be an infographic, detail, feature, or measurement image.
Use information-preserving background replacement mode:
- Change or improve the non-text background/photo areas so the image looks more
  attractive and less identical to the source.
- You may replace plain white, grey, studio, room, yard, floor, wall, and photo
  background areas with a clean premium ecommerce scene, subtle studio
  environment, soft catalog backdrop, or polished neutral background, as long as
  all original information remains readable.
- The new background must not contain another copy of the product, product
  parts, eggs, nests, ramps, doors, coop panels, close-up detail photos, labels,
  measurements, or any product-shaped content.
- Do not remove, replace, summarize, or redesign any original selling-point text,
  title, subtitle, measurement, number, icon, arrow, label, circle inset,
  diagram, callout, or information panel.
- Treat product/detail photos, circle insets, diagrams, comparison images, and
  measurement graphics as protected information regions too. Keep their
  original position, scale, crop, angle, and count.
- Do not zoom, enlarge, move, duplicate, crop, or create new product/detail
  photo regions. Do not add extra close-ups.
- Do not add any selling-point text or information panel that is not in the
  source image.
- Keep the original text and information areas in the same positions and at the
  same approximate size. They must remain readable.
- If preserving information conflicts with changing the background, preserve the
  information and keep only the immediate area behind that information clean.
- Keep the original infographic layout, but do not keep large blank/background
  areas unchanged when they can be replaced without covering text or dimensions.
- Background replacement may happen only in blank/background areas around the
  protected information regions.
- Treat protected product/detail/inset regions as foreground overlays on top of
  the new background, not as objects to redraw into the background.
- Use one continuous, unified background/scene across the whole canvas wherever
  it is visible. Avoid hard horizontal cuts, separate top banners with an
  unrelated original background, or a pasted-poster feeling.`;

export const IMAGE_CLASSIFICATION_PROMPT = `You are classifying an ecommerce product source image before image-to-image
background replacement.

Return only one compact JSON object with this schema:
{"mode":"plain|information","confidence":0.0,"has_text":false,"has_dimensions":false,"has_callouts":false,"reason":"short reason"}

Classification rules:
- Use "information" if the image contains any selling-point text, dimensions,
  arrows, icons, diagrams, labels, callout cards, badges, comparison panels,
  inset/detail photos, measurement lines, UI-like white information areas, or
  feature/selling-point overlays.
- Use "plain" only when it is mainly a product/lifestyle/photo render with no
  informative overlays and no visible product claims or measurements.
- Do not transcribe text. Do not invent product claims. Only classify the
  visible source image.`;

export const SCENE_DESCRIPTION_PROMPT_TEMPLATE = `You are an ecommerce art director choosing a realistic, attractive background scene for ONE product photo. The product itself will be composited in later — so your scene description must describe ONLY the space, surfaces, lighting, mood, and one supporting prop, never the product's shape/structure/material/parts (describing the product makes the renderer invent a fake one).

STEP 1 — identify the product. Look at the image and name the real physical product (ignore any printed text, labels, or infographics) and its category, e.g. furniture, kitchenware, decor, lighting, outdoor gear, garden items, pet/poultry items, tools, storage, fitness, kids' items, office, bathroom, seasonal, etc.

STEP 2 — choose the place where this product is genuinely used or displayed. The scene must feel natural for THAT product, not a generic showroom. FURNITURE is the main category, so match the specific furniture subtype to its real setting (adapt freely, vary across the product's photos):

FURNITURE (the most common — be specific, don't default everything to "living room"):
- sofa / sectional / loveseat / couch / daybed -> living room, family room, sunroom, or boutique lobby
- armchair / accent chair / recliner / chaise -> reading nook, living-room corner, bay window, study
- coffee table / console / side table / nesting tables -> living room, entryway, or hallway
- TV stand / media console / entertainment center -> living room or family room, media wall
- bookshelf / bookcase / display cabinet / etagere -> home library, study, or living-room wall
- dining set / dining table / dining chairs / bar stools -> dining room, kitchen, or eat-in nook
- kitchen island / cart / pantry cabinet / sideboard / credenza -> kitchen or dining room
- desk / writing table / study table / computer desk -> home office, study, or studio
- office chair / task chair / gaming chair -> home office, study, or gaming setup
- filing cabinet / storage cabinet / locker -> home office, study, or utility room
- wardrobe / armoire / closet system / dresser / chest of drawers -> dressing room or walk-in closet area
- nightstand / bedside table -> alongside a seating nook (NOT a sleeping room)
- vanity / makeup table / dressing table -> dressing area or walk-in closet
- entryway / shoe cabinet / shoe bench / coat rack -> foyer, hallway, or mudroom
- bar cart / wine cabinet / bar counter -> dining room, living room, or home bar nook
- coffee/tv console + matching set -> styled living room
- loft / kids study desk combos -> bright kids' playroom or study room
- ottoman / pouf / footstool / bench (seating) -> living room, entryway, or foot-of-stairs nook
- outdoor furniture (patio set, lounger, bistro set, swing) -> covered terrace, courtyard, garden patio, or balcony
- plant stand / plant shelf / planter bench -> garden patio, sunroom, or conservatory
- nursery / kids furniture (crib-adjacent, toy shelf, kids chair) -> bright nursery or playroom

OTHER categories (still product-appropriate, not generic showroom):
- kitchenware / tableware / cookware -> dining room or kitchen
- outdoor gear / garden items / planters -> covered terrace, courtyard, or garden patio
- tools / workshop / garage items -> workshop, garage, or maker space
- bathroom / spa items -> clean modern bathroom or spa-like washroom
- fitness / sports gear -> home gym, studio, or outdoor court
- pet or poultry items -> the room, yard, or coop where the animal would use it
- lighting / mirrors / wall art / general decor -> the room whose mood best fits the piece
A styled studio, gallery, boutique, lobby, or atrium is allowed ONLY when it truly suits the product.

STEP 3 — give the scene a distinct ARCHITECTURAL / INTERIOR STYLE, different for each image of the same product so the photos don't look alike. Lean THIS image toward the style persona below (keep the room product-appropriate, but adopt this persona's architecture, materials, palette, and light):
{style_hint}
This is image #{image_index} of the same product. Each image must show a genuinely different architectural style, house/room type, flooring material, and color mood — think "different house, different design language" across the photos, never the same room restyled. For example, the same frame can sit in a scandinavian apartment, a mediterranean villa, a japanese zen house, an industrial loft, or a mid-century home — use the persona to drive that variety.

Describe the scene in ONE or TWO rich English sentences covering: the space type, the flooring or ground surface, the lighting, the color mood, and ONE supporting prop that shows how the product is used. Be specific and vivid (named materials, named light quality, a concrete prop), not vague.

Safety for the downstream renderer (your scene text is reused verbatim): describe only space, materials, lighting, and one prop. Call any window covering "curtains". Never describe private or intimate settings. Keep all wording clean and catalog-safe.

{constraints}

Return ONLY a compact JSON object, nothing else:
{{"scene":"<the scene description you designed>","product":"<short product subject phrase>"}}

Good product-matched examples (adapt freely, never copy verbatim; note each describes the scene and one prop, NOT the product itself):
- sofa: "spacious living room with wide-plank oak floor, soft north window light, a potted olive tree in the corner"
- accent chair: "cozy reading nook with herringbone parquet, warm floor-lamp glow, a small stack of books"
- coffee table: "modern living room with light oak floor, bright afternoon daylight, a ceramic vase on the surface"
- dining set: "modern dining room with walnut floor, warm pendant light overhead, a ceramic bowl of fruit"
- bar stools: "kitchen island area with polished concrete floor, bright skylight, a wooden cutting board"
- desk: "home office with light oak floor and clean cool daylight, a brass desk lamp"
- office chair: "minimalist study with pale wood floor, soft even daylight, a small potted succulent"
- bookshelf: "home library with dark walnut floor and warm reading-lamp light, floor-to-ceiling shelves"
- wardrobe: "walk-in dressing area with travertine floor, soft warm glow, a neatly folded stack of linen"
- entryway cabinet: "bright foyer with marble tile floor, soft daylight through sheer curtains, a brass key bowl"
- bar cart: "stylish living-room corner with parquet floor, warm evening glow, two crystal glasses"
- outdoor lounger: "covered terrace with warm wood decking and golden-hour light, lush potted greenery"
- plant stand: "sun-filled conservatory with tiled floor, abundant greenery, filtered soft light"
- kids desk combo: "bright playroom with pale maple floor and soft daylight, a small wooden toy wagon"
- workshop tool: "clean workshop with sealed concrete floor, bright overhead daylight, neatly hung hand tools"
- spa item: "calm spa washroom with pale stone floor, soft diffused light, a neatly rolled towel"`;

/** 组装最终图片生成 prompt。 */
export function imageGenerationPrompt(
  outputSize: [number, number],
  opts: {
    informationMode: boolean;
    sceneHint?: string;
    productSubject?: string;
    colorHint?: string;
  },
): string {
  const [width, height] = outputSize;
  const parts: string[] = [];
  parts.push(
    (opts.informationMode ? DEFAULT_BACKGROUND_PROMPT : PLAIN_PRODUCT_BACKGROUND_PROMPT).trim(),
  );
  const sceneText = (opts.sceneHint ?? "").trim() || SCENE_CONSTRAINTS;
  let sceneBlock = `SCENE: ${sceneText}`;
  if (opts.productSubject) {
    sceneBlock += `\nProduct subject: ${opts.productSubject}.`;
  }
  const colorHint = (opts.colorHint ?? "").trim();
  if (colorHint) {
    sceneBlock +=
      `\nProduct color fidelity: the product's real color/material is ${colorHint}. ` +
      "You MUST keep the product's exact original colors, finishes, and materials from the " +
      "reference image; do not recolor, tint, or replace them with generic placeholders.";
  }
  parts.push(sceneBlock.trim());
  if (opts.informationMode) parts.push(INFORMATION_IMAGE_PROMPT.trim());
  parts.push(`Output requirement: generate the final ecommerce image at exactly ${width}x${height} pixels.`);
  return parts.join("\n\n");
}
