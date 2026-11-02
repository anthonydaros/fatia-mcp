import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export async function checkInstallation(entry) {
    if (Number(process.versions.node.split('.')[0]) < 24)
        throw Error('O Fatia exige Node.js24 ou superior.');
    const client = new Client({ name: 'fatia-installation-check', version: '1' });
    try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--stdio'], stderr: 'pipe', env: { ...process.env, MCP_TRANSPORT: 'stdio' } }));
        const tools = (await client.listTools()).tools.map(t => t.name);
        const response = await client.callTool({ name: 'slicer_info', arguments: { check_updates: false } });
        if (response.isError)
            throw Error('O servidor iniciou, mas não foi possível consultar o Bambu Studio. Confira SLICER_PATH.');
        const content = response.content;
        const slicer = JSON.parse(content.find(c => c.type === 'text')?.text ?? 'null');
        return { ok: true, node: process.versions.node, server: client.getServerVersion(), tools, slicer, client_tools_loaded: 'unknown', next: 'Servidor validado. Se acabou de registrar ou atualizar o MCP, reinicie seu assistente para recarregar as ferramentas. Nenhum arquivo foi fatiado.' };
    }
    finally {
        await client.close();
    }
}
