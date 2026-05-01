export type JSONable = Record<string, any>;

export abstract class Cache {
    protected store: Map<string, any>;

    constructor( initial?: JSONable ) {
        this.store = new Map<string, any>( Object.entries( initial ?? {} ) );
    }

    get<T = any>( key: string ): T | undefined {
        return this.store.get( key ) as T | undefined;
    }

    set( key: string, value: any ): void {
        this.store.set( key, value );
    }

    delete( key: string ): boolean {
        return this.store.delete( key );
    }

    clear(): void {
        this.store.clear();
    }

    toJSON(): JSONable {
        return Object.fromEntries( this.store.entries() );
    }

    loadFromJSON( obj: JSONable ): void {
        this.store = new Map<string, any>( Object.entries( obj ) );
    }

    async clearCache(): Promise<void> {
        this.store.clear();
    }

    async setKey(key: string, value: any): Promise<void> {
        this.set(key, value);
    }

    async getKey<T = any>(key: string): Promise<T | undefined> {
        return this.get<T>(key);
    }
}

export default Cache;
