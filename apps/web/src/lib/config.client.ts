// Client-safe: keep these reads literal so Next can inline public build values.
// No live reads occur until the corresponding input is first requested.
const publicInputs = {
  NEXT_PUBLIC_FIREBASE_API_KEY: () => process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: () => process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: () => process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: () => process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: () => process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: () => process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  NODE_ENV: () => process.env.NODE_ENV,
};

const optionalText = (value: string | undefined) => value?.trim() || undefined;
const publicDefinition = (capabilities: readonly string[]) => ({
  classification: "ordinary configuration" as const,
  environments: ["production", "preview", "local", "test"] as const,
  capabilities,
  parse: optionalText,
});

// The companion catalog check can inspect definitions without calling readers.
export const publicInputDefinitions = {
  NEXT_PUBLIC_FIREBASE_API_KEY: publicDefinition(["firebase-browser"]),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: publicDefinition(["firebase-browser"]),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: publicDefinition(["firebase-browser", "firebase-admin"]),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: publicDefinition(["firebase-browser"]),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: publicDefinition(["firebase-browser"]),
  NEXT_PUBLIC_FIREBASE_APP_ID: publicDefinition(["firebase-browser"]),
  NODE_ENV: publicDefinition(["devtools"]),
};

export type PublicInputName = keyof typeof publicInputDefinitions;

// Injection supplies synthetic values to the real parsers, not an alternate
// deployment source. Runtime consumers use the singleton below.
export const createPublicConfig = (
  read: (name: PublicInputName) => string | undefined = name => publicInputs[name]()
) => {
  const values = new Map<PublicInputName, string | undefined>();
  const input = (name: PublicInputName) => {
    if (!values.has(name)) values.set(name, publicInputDefinitions[name].parse(read(name)));
    return values.get(name);
  };
  let firebase: Readonly<{
    apiKey?: string; authDomain?: string; projectId?: string;
    storageBucket?: string; messagingSenderId?: string; appId?: string;
  }> | undefined;
  return Object.freeze({
    firebaseProjectId: () => input("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
    firebase: () => firebase ??= Object.freeze({
      apiKey: input("NEXT_PUBLIC_FIREBASE_API_KEY"),
      authDomain: input("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
      projectId: input("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
      storageBucket: input("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"),
      messagingSenderId: input("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
      appId: input("NEXT_PUBLIC_FIREBASE_APP_ID"),
    }),
    devtoolsEnabled: () => input("NODE_ENV") !== "production",
  });
};

export const publicConfig = createPublicConfig();
