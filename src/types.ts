export interface CdnConfig {
  image_servers: string[];
  thumb_servers: string[];
}

export interface GalleryListItem {
  id: number;
  media_id: string;
  english_title: string;
  japanese_title: string | null;
  thumbnail: string;
  thumbnail_width: number;
  thumbnail_height: number;
  num_pages: number;
  num_favorites: number;
  tag_ids: number[];
  blacklisted: boolean;
}

export interface Paginated<T> {
  result: T[];
  num_pages: number;
  per_page: number;
  total: number | null;
}

export interface Tag {
  id: number;
  type: string;
  name: string;
  slug: string;
  url?: string;
  count?: number;
  description?: string | null;
}

export interface PageInfo {
  number: number;
  path: string;
  width: number;
  height: number;
  thumbnail: string;
  thumbnail_width: number;
  thumbnail_height: number;
}

export interface GalleryTitle {
  english: string;
  japanese: string | null;
  pretty: string;
}

export interface CoverInfo {
  path: string;
  width: number;
  height: number;
}

export interface GalleryDetail {
  id: number;
  media_id: string;
  title: GalleryTitle;
  cover: CoverInfo;
  thumbnail: CoverInfo;
  scanlator?: string;
  upload_date: number;
  tags: Tag[];
  num_pages: number;
  num_favorites: number;
  pages: PageInfo[];
}

export type SortOrder =
  | "date"
  | "popular"
  | "popular-today"
  | "popular-week"
  | "popular-month";