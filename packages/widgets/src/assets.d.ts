declare module "*.png" {
  const url: string;
  export default url;
}

// Bundler-handled stylesheet imports (maplibre-gl's, loaded dynamically
// alongside the map engine). The package has no vite/client types of its own.
declare module "*.css";
