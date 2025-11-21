import { MetabaseProvider as MetabaseSDKProvider } from '@metabase/embedding-sdk-react';

const METABASE_INSTANCE_URL = import.meta.env.VITE_METABASE_URL || 'http://localhost:3333';
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

export function MetabaseProvider({ children }) {
  return (
    <MetabaseSDKProvider
      metabaseInstanceUrl={METABASE_INSTANCE_URL}
      jwtProviderUri={`${API_BASE_URL}/api/metabase/embed-token/sdk`}
    >
      {children}
    </MetabaseSDKProvider>
  );
}

export default MetabaseProvider;
