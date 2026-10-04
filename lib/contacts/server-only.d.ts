// Next.js resolves `import "server-only"` itself (installing the package is optional, per its docs): an empty
// module on the server, a build error in a client bundle. TypeScript checks side-effect imports, so it is
// told here that the module exists.
declare module "server-only";
