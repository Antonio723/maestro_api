import jwt from 'jsonwebtoken';

// Middleware para verificar autenticação JWT
export const authenticate = (req, res, next) => {
  try {
    // Obter token do header Authorization
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Token de autenticação não fornecido'
      });
    }

    // Formato esperado: "Bearer TOKEN"
    const parts = authHeader.split(' ');

    if (parts.length !== 2) {
      return res.status(401).json({
        success: false,
        message: 'Formato de token inválido'
      });
    }

    const [scheme, token] = parts;

    if (!/^Bearer$/i.test(scheme)) {
      return res.status(401).json({
        success: false,
        message: 'Token mal formatado'
      });
    }

    // Verificar token
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Adicionar dados do usuário ao request
      req.user = decoded;
      console.log('✅ Token validado para usuário:', decoded.email || decoded.id);
      next();
    } catch (jwtError) {
      console.log('❌ Token inválido:', jwtError.message);
      return res.status(401).json({
        success: false,
        message: 'Token inválido ou expirado'
      });
    }
  } catch (error) {
    console.error('❌ Erro na autenticação:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao verificar autenticação'
    });
  }
};
